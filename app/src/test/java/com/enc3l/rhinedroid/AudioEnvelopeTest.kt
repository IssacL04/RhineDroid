package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class AudioEnvelopeTest {
    @Test fun fadeTakes450msAndInterruptedChangeStartsAtTheCurrentLevel() {
        val gain=AudioEnvelope()
        gain.to(0f,1000,450)
        assertEquals(1f,gain.sample(1000),0f)
        assertEquals(.5f,gain.sample(1225),.0001f)
        gain.to(1f,1225,450)
        assertEquals(.5f,gain.sample(1225),.0001f)
        assertEquals(.75f,gain.sample(1450),.0001f)
        assertEquals(1f,gain.sample(1675),0f)
        assertTrue(gain.settled(1675))
        gain.to(0f,1700,0); assertEquals(0f,gain.sample(1700),0f)
    }
}
