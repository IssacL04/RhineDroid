/** Frame statistics exclude loading time and hidden-tab pauses. CPU submission
 * time is deliberately not called GPU time: the GPU runs asynchronously. */
export class MusicFrameTiming {
  private previous: number | undefined;
  private gaps: number[] = [];
  private cpu: number[] = [];
  reset() { this.previous = undefined; this.gaps = []; this.cpu = []; }
  begin(now: number) {
    if (this.previous !== undefined) {
      this.gaps.push(Math.max(0, now - this.previous));
      if (this.gaps.length > 240) this.gaps.shift();
    }
    this.previous = now;
  }
  end(elapsed: number) {
    this.cpu.push(Math.max(0, elapsed));
    if (this.cpu.length > 240) this.cpu.shift();
  }
  snapshot() {
    const percentile = (values: number[], q: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0).toFixed(2);
    };
    const duration = this.gaps.reduce((sum, gap) => sum + gap, 0);
    return { samples: this.gaps.length, fps: duration ? +(1000 * this.gaps.length / duration).toFixed(1) : 0,
      frameP50: percentile(this.gaps, .5), frameP95: percentile(this.gaps, .95),
      frameMax: percentile(this.gaps, 1), over50ms: this.gaps.filter((gap) => gap > 50).length,
      cpuP95: percentile(this.cpu, .95) };
  }
}
