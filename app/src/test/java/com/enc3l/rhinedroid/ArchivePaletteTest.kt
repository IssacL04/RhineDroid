package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.pow

class ArchivePaletteTest {
    @Test fun systemBarsAndLinearGpuPaperShareTheCssColors() {
        assertEquals(0xffe8e5e1.toInt(), ArchivePalette.color(0.0))
        assertEquals(0xff08121f.toInt(), ArchivePalette.color(1.0))
        for (step in 0..100) ArchivePalette.channels(step/100.0).forEach { srgb ->
            val linear=ArchivePalette.linear(srgb).toDouble()
            val restored=if(linear<=.0031308)linear*12.92 else 1.055*linear.pow(1/2.4)-.055
            assertEquals(srgb,restored,1e-7)
        }
    }
}
