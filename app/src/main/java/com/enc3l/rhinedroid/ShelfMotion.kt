package com.enc3l.rhinedroid

import kotlin.math.*

/** Same quintic position / velocity / acceleration handoff as music-archive-motion.ts. */
internal class ShelfMotion {
    data class Sample(val position: Float, val velocity: Float = 0f, val acceleration: Float = 0f)
    val origin = FloatArray(ShelfLayout.COUNT * 4)
    val velocity = FloatArray(ShelfLayout.COUNT * 4)
    val acceleration = FloatArray(ShelfLayout.COUNT * 4)
    val target = FloatArray(ShelfLayout.COUNT * 4)
    var start = 0f; private set
    var duration = .001f; private set
    private var keys = emptyList<Long>()
    fun settled(now: Float) = now - start >= duration
    fun sample(index: Int, axis: Int, now: Float): Sample {
        val n = index * 4 + axis
        if (settled(now)) return Sample(target[n])
        val t = (now - start).coerceIn(0f, duration)
        val d = target[n] - origin[n] - velocity[n] * duration - acceleration[n] * duration * duration / 2
        val v = -velocity[n] - acceleration[n] * duration
        val a = -acceleration[n]
        val c3 = (10 * d - 4 * v * duration + a * duration * duration / 2) / duration.pow(3)
        val c4 = (-15 * d + 7 * v * duration - a * duration * duration) / duration.pow(4)
        val c5 = (6 * d - 3 * v * duration + a * duration * duration / 2) / duration.pow(5)
        return Sample(origin[n] + velocity[n] * t + acceleration[n] * t * t / 2 + c3 * t.pow(3) + c4 * t.pow(4) + c5 * t.pow(5),
            velocity[n] + acceleration[n] * t + 3 * c3 * t * t + 4 * c4 * t.pow(3) + 5 * c5 * t.pow(4),
            acceleration[n] + 6 * c3 * t + 12 * c4 * t * t + 20 * c5 * t.pow(3))
    }
    fun retarget(cells: List<ShelfLayout.Cell>, detail: Float, now: Float, seconds: Float, dx: Float = 0f, dz: Float = 0f) {
        val previous = keys.withIndex().associate { it.value to it.index }
        val old = Array(keys.size) { i -> Array(3) { axis -> sample(i, axis, now) } }
        val center = old.getOrNull(ShelfLayout.SELECTED)
        val nextKeys = cells.map { (it.physicalLane.toLong() shl 32) xor (it.physicalRow.toLong() and 0xffffffffL) }
        cells.forEachIndexed { i, cell ->
            val distance = cell.z / .62f
            val shoulder = ArchivePose.shoulder(distance.toDouble(), (cell.x / 5.2f).toDouble()).toFloat()
            val end = floatArrayOf(cell.x, -4.6f + shoulder + if (i == ShelfLayout.SELECTED) .9f + detail * 2.57f else 0f, cell.z)
            val source = previous[nextKeys[i]]?.let { old[it] }
            for (axis in 0..2) {
                val fallback = when (axis) {
                    0 -> end[0] + dx.coerceIn(-5.2f, 5.2f) + (center?.get(0)?.position ?: 0f)
                    2 -> end[2] + dz.coerceIn(-.62f*(ShelfLayout.ROWS/2), .62f*(ShelfLayout.ROWS/2)) + (center?.get(2)?.position ?: 0f)
                    else -> end[1] - if (i == ShelfLayout.SELECTED) .9f + detail * 2.57f else 0f
                }
                val state = source?.get(axis) ?: Sample(fallback)
                val n = i * 4 + axis
                target[n] = end[axis]
                origin[n] = if (seconds <= 0f || previous.isEmpty()) end[axis] else state.position
                velocity[n] = if (seconds <= 0f) 0f else state.velocity
                acceleration[n] = if (seconds <= 0f) 0f else state.acceleration
            }
        }
        keys = nextKeys; start = now; duration = max(.001f, seconds)
    }
    companion object {
        fun duration(lanes: Float, rows: Float): Float = 1.4f + ((hypot(lanes, rows / 8) - 1) / 7).coerceIn(0f, 1f)
        fun occurrence(index: Int, center: Int, count: Int, direction: Int = 0): Int {
            if (count <= 0) return 0
            val nearby = index + floor((center - index).toDouble() / count + .5).toInt() * count
            return if (direction > 0 && nearby <= center) nearby + count else if (direction < 0 && nearby >= center) nearby - count else nearby
        }
    }
}
