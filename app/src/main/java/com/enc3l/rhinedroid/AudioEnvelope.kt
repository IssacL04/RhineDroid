package com.enc3l.rhinedroid

internal class AudioEnvelope(initial: Float = 1f) {
    private var from = initial
    var target = initial; private set
    private var start = 0L
    private var duration = 0L
    fun sample(now: Long): Float = if (duration == 0L) target else
        from + (target-from)*((now-start).toFloat()/duration).coerceIn(0f,1f)
    fun settled(now: Long) = now-start >= duration
    fun to(value: Float, now: Long, milliseconds: Long) {
        require(value.isFinite() && value in 0f..1f && milliseconds >= 0)
        from=sample(now); target=value; start=now; duration=milliseconds
    }
}
