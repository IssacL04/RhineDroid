package com.enc3l.rhinedroid

import kotlin.math.pow
import kotlin.math.roundToInt

/** The same sRGB paper colors as music.css, converted only at the GPU boundary. */
internal object ArchivePalette {
    private val day = intArrayOf(232, 229, 225)
    private val night = intArrayOf(8, 18, 31)
    fun channels(progress: Double) = DoubleArray(3) { (day[it] + (night[it]-day[it])*progress.coerceIn(0.0,1.0))/255.0 }
    fun linear(value: Double): Float = (if(value <= .04045) value/12.92 else ((value+.055)/1.055).pow(2.4)).toFloat()
    fun color(progress: Double): Int {
        val rgb=channels(progress).map { (it*255).roundToInt() }
        return (0xff shl 24) or (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2]
    }
}
