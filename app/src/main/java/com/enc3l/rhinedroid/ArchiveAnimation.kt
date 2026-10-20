package com.enc3l.rhinedroid

import kotlin.math.*

/** Original music-camera.ts placement curve, sampled on the renderer's shared clock. */
internal class ArchiveScalar(initial: Double = 0.0) {
    private var origin = initial
    private var velocity = 0.0
    private var acceleration = 0.0
    var target = initial; private set
    private var start = -1e9
    private var duration = .001
    data class Sample(val value: Double, val velocity: Double = 0.0, val acceleration: Double = 0.0)
    fun settled(now: Double) = now - start >= duration
    fun sample(now: Double): Sample {
        if (settled(now)) return Sample(target)
        val t = ((now - start) / duration).coerceIn(0.0, 1.0)
        val d = target - origin - velocity * duration - acceleration * duration * duration / 2
        val v = -velocity - acceleration * duration
        val a = -acceleration
        val c3 = 10*d - 4*v*duration + a*duration*duration/2
        val c4 = -15*d + 7*v*duration - a*duration*duration
        val c5 = 6*d - 3*v*duration + a*duration*duration/2
        val value = origin + velocity*duration*t + acceleration*duration*duration*t*t/2 + c3*t.pow(3) + c4*t.pow(4) + c5*t.pow(5)
        return Sample(value, velocity + acceleration*duration*t + (3*c3*t*t + 4*c4*t.pow(3) + 5*c5*t.pow(4))/duration,
            acceleration + (6*c3*t + 12*c4*t*t + 20*c5*t.pow(3))/(duration*duration))
    }
    fun to(value: Double, now: Double, seconds: Double) {
        val current = sample(now)
        origin = if (seconds <= 0) value else current.value
        velocity = if (seconds <= 0) 0.0 else current.velocity
        acceleration = if (seconds <= 0) 0.0 else current.acceleration
        target = value; start = now; duration = max(.001, seconds)
    }
}

/** Closed-form damping from motion.ts; frame rate does not change the path. */
internal class ArchiveSpring(var value: Double = 0.0) {
    var velocity = 0.0
    fun update(target: Double, dt: Double, rate: Double = 9.0, immediate: Boolean = false) {
        if (immediate) { value = target; velocity = 0.0; return }
        val delta = value - target
        val impulse = velocity + rate * delta
        val decay = exp(-rate * max(0.0, dt))
        value = target + (delta + impulse * dt) * decay
        velocity = (velocity - rate * impulse * dt) * decay
    }
    fun settled(target: Double, position: Double = .008, speed: Double = .035) = abs(value-target) < position && abs(velocity) < speed
}

internal object ArchivePose {
    fun focusDistance(camera: Camera, point: DoubleArray): Double {
        val distance=sqrt((0..2).sumOf { (camera.aim[it]-camera.position[it]).pow(2) }).coerceAtLeast(.001)
        return ((0..2).sumOf { (point[it]-camera.position[it])*(camera.aim[it]-camera.position[it]) }/distance).coerceAtLeast(.1)
    }
    const val PLACEMENT_SECONDS = 1.45 / 1.05
    fun smooth(value: Double): Double = value.coerceIn(0.0,1.0).let { it*it*it*(10+it*(-15+6*it)) }
    private fun shoulderAt(row: Double, time: Double): Double {
        val age = time - 25.05 - abs(row)*.065
        val envelope = max(-.42, 2.15 - .17*(sqrt(row*row+1)-1))
        val ring = if (age > 0) sin(age*5.1)*exp(-age*1.3) else 0.0
        val rebound=.06+.12*smooth((time-26.2)/.36)
        return envelope*(smooth(age/.62)+rebound*ring*smooth(age/.16))
    }
    fun shoulder(row: Double, lane: Double) = shoulderAt(row,26.56)*(.25+.75*exp(-.5*(lane/.55).pow(2)))
    fun introEntryZ(time: Double) = -23*(1-((time-21.92)/.75).coerceIn(0.0,1.0)).pow(2)
    /** Camera anchoring samples the same height as archive.mat; it never moves the mesh on the CPU. */
    fun openingHeight(row: Double, lane: Double, time: Double): Double {
        fun bell(x: Double, width: Double) = exp(-.5*(x/width).pow(2))
        fun packet(x: Double) = 2.5*bell(x,3.8)-.58*bell(x-6,3.5)
        val t=time-22; val phase=row+12+lane*.65
        val wave=smooth(t/.32)*(packet(phase-3-t*19)*(1-smooth((t-2.15)/.65))+
            packet(phase-32+(t-2.3)*24)*smooth((t-2.17)/.32)*(1-smooth((t-3.5)/.85)))
        val handoff=smooth((time-24.95)/.45); val selection=smooth((time-25.4)/.95)
        val weight=.25+.75*bell(lane,.55)
        val field=.62*wave*(1-handoff)+shoulderAt(row,time+.3*handoff*(1-selection))*(1+(weight-1)*selection)
        return field+(shoulder(row,lane)-field)*smooth((time-25.3)/1.42)
    }
    data class Camera(val position: DoubleArray, val aim: DoubleArray, val span: Double)
    fun camera(width: Int, height: Int, detail: Double, overview: Double, intro: Double? = null): Camera {
        val aspect = width.toDouble()/max(1,height)
        val portrait = aspect < 1.05
        val orbit = if (intro != null) smooth((intro-22.6)/1.6) else 1.0
        val settle = if (intro != null) smooth((intro-24.25)/2.25) else 1.0
        var yaw = (89-22*orbit-8*settle)*(1-detail)+8*detail
        var elevation = (if (intro != null) 3+40*smooth((intro-21.96)/.22)-8*orbit-16*settle+6*smooth((intro-25.3)/1.42) else 25.0)*(1-detail)+20*detail
        yaw += (28-yaw)*overview; elevation += (43-elevation)*overview
        val y = yaw*PI/180; val e = elevation*PI/180
        val direction = doubleArrayOf(-sin(y)*cos(e), sin(e), cos(y)*cos(e))
        val right = doubleArrayOf(cos(y),0.0,sin(y))
        val up = doubleArrayOf(sin(y)*sin(e),cos(e),-cos(y)*sin(e))
        val baseSpan = ((10.8+(10.3-10.8)*orbit)*(1-settle)+7.33*settle)*(1-detail)+5.9*detail
        val portraitDetail = max(6.3/aspect,3.7*height/max(100.0,.54*height-156))
        var span = if (portrait) max(baseSpan,8.4/aspect+(portraitDetail-8.4/aspect)*detail) else max(baseSpan,baseSpan*(16.0/9)/aspect)
        val wide = smooth((aspect-16.0/9)/(21.0/9-16.0/9))
        val arrayAim=doubleArrayOf(-1.091,(-2.55+.4*orbit)*(1-settle)-.045*settle,2.48+(0.481-2.48)*settle+2.17)
        val preview=arrayAim.copyOf()
        val introBlend=if(intro==null)1.0 else smooth((intro-25.3)/1.42)
        if(intro!=null) {
            val pan=smooth((intro-25.4)/.95)
            for(i in 0..2) preview[i]+=right[i]*(-2.05*(1-pan)*smooth((intro-24.2)/.8))
            if(intro>=25.05) {
                val tracking=smooth((intro-25.4)/1.05)
                val lift=.4*smooth((intro-25.58)/.82)+2.95*smooth((intro-27.55)/1.3)
                val modelLift=lift+(.9-lift)*introBlend
                val anchor=doubleArrayOf(-2.225,-4.6+openingHeight(0.0,0.0,intro)+modelLift+3.525,introEntryZ(intro))
                val pixelScale=1080/baseSpan
                for(i in 0..2) {
                    anchor[i]+=right[i]*(120+322*tracking)/pixelScale+up[i]*(-200-52*tracking)/pixelScale
                    preview[i]+=(anchor[i]-preview[i])*smooth((intro-25.05)/.35)
                }
            }
        }
        val destination=if(portrait) doubleArrayOf(0.0,-4.6+shoulder(0.0,0.0)+.4+1.85,0.0) else arrayAim
        val shiftX = if (portrait) 0.0 else .035*wide
        val shiftY = if (portrait) .36-.5 else .08+.02*wide
        for (i in 0..2) {
            destination[i]+=right[i]*shiftX*span*aspect+up[i]*shiftY*span
            preview[i]+=(destination[i]-preview[i])*introBlend
        }
        val inspected = doubleArrayOf(0.0,-4.6+shoulder(0.0,0.0)+3.47+1.85,0.0)
        val detailY = if (portrait) .27+34.0/height else .49
        for (i in 0..2) inspected[i] += right[i]*(if (portrait) 0.0 else .25)*span*aspect + up[i]*(detailY-.5)*span
        val aim = DoubleArray(3) { preview[it]+(inspected[it]-preview[it])*detail }
        val overviewAim = doubleArrayOf(0.0,-1.8,.67)
        for(i in 0..2) aim[i]+=(overviewAim[i]-aim[i])*overview
        span += (max(16.8,17.5/aspect)-span)*overview
        val distance = ((28+7*orbit)*(1-settle)+140*settle)*(1-detail)+72*detail
        return Camera(DoubleArray(3) { aim[it]+direction[it]*(distance+(172-distance)*overview) },aim,span)
    }
}

/** Placement already has its own curve; only a viewport change needs another transition. */
internal class ArchiveCameraMotion {
    var pose: ArchivePose.Camera? = null; private set
    private var from: ArchivePose.Camera? = null
    private var start = 0.0
    val moving get() = from != null
    fun resize(now: Double) { from = pose; start = now }
    fun sample(target: ArchivePose.Camera, now: Double, immediate: Boolean = false): ArchivePose.Camera {
        val origin = from
        val blend = if (immediate) 1.0 else ArchivePose.smooth((now-start)/.32)
        val value = if (origin == null || blend >= 1) target else ArchivePose.Camera(
            DoubleArray(3) { origin.position[it]+(target.position[it]-origin.position[it])*blend },
            DoubleArray(3) { origin.aim[it]+(target.aim[it]-origin.aim[it])*blend },
            origin.span+(target.span-origin.span)*blend)
        if (blend >= 1 || immediate) from = null
        pose = value
        return value
    }
}
