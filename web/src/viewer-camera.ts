import * as THREE from "three";

const shortestAngle = (angle: number) =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

// OrbitControls records the requested pose; this camera is what is rendered.
// Spherical interpolation avoids cutting through the model on a large reset.
export class ViewerCameraMotion {
  readonly focus = new THREE.Vector3();
  private pose = new THREE.Spherical();
  private desired = new THREE.Spherical();
  private offset = new THREE.Vector3();
  private resetFrom = new THREE.Spherical();
  private resetFocus = new THREE.Vector3();
  private elapsed = 0;
  resetting = false;

  constructor(private camera: THREE.PerspectiveCamera) {}

  snap(goal: THREE.PerspectiveCamera, target: THREE.Vector3) {
    this.resetting = false;
    this.focus.copy(target);
    this.pose.setFromVector3(this.offset.copy(goal.position).sub(target));
    this.apply();
  }

  reset() {
    this.resetFrom.copy(this.pose);
    this.resetFocus.copy(this.focus);
    this.elapsed = 0;
    this.resetting = true;
  }

  interruptReset(goal: THREE.PerspectiveCamera, target: THREE.Vector3) {
    if (!this.resetting) return;
    this.resetting = false;
    goal.position.copy(this.camera.position);
    target.copy(this.focus);
    goal.lookAt(target);
  }

  update(
    goal: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    dt: number,
    reduced = false,
  ) {
    if (reduced) {
      this.snap(goal, target);
      return;
    }
    this.desired.setFromVector3(this.offset.copy(goal.position).sub(target));
    if (this.resetting) {
      this.elapsed += Math.max(0, dt);
      const t = Math.min(1, this.elapsed / 0.56);
      const p = 1 - (1 - t) ** 3;
      this.focus.lerpVectors(this.resetFocus, target, p);
      this.interpolate(this.resetFrom, this.desired, p, p);
      if (t === 1) this.resetting = false;
    } else {
      const pan = 1 - Math.exp(-13 * Math.max(0, dt));
      const orbit = 1 - Math.exp(-9 * Math.max(0, dt));
      const zoom = 1 - Math.exp(-15 * Math.max(0, dt));
      this.focus.lerp(target, pan);
      this.interpolate(this.pose, this.desired, orbit, zoom);
      if (this.focus.distanceToSquared(target) < 1e-10) this.focus.copy(target);
    }
    this.apply();
  }

  private interpolate(
    from: THREE.Spherical,
    to: THREE.Spherical,
    angle: number,
    radius: number,
  ) {
    // Interpolate logarithmic distance so zoom in and zoom out feel symmetric.
    this.pose.radius = Math.exp(
      THREE.MathUtils.lerp(Math.log(from.radius), Math.log(to.radius), radius),
    );
    this.pose.phi = THREE.MathUtils.lerp(from.phi, to.phi, angle);
    this.pose.theta = from.theta + shortestAngle(to.theta - from.theta) * angle;
    this.pose.makeSafe();
  }

  private apply() {
    this.camera.position
      .copy(this.offset.setFromSpherical(this.pose))
      .add(this.focus);
    this.camera.lookAt(this.focus);
  }
}
