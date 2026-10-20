package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class MetadataMatchTest {
    private val local=MetadataMatch.Track("local","Signal","Orbit Studio","Daylight",180.0)
    private val song=local.copy(id="abc123")
    @Test fun exactEvidenceAcceptsOneRecordingAndRejectsAmbiguousVersions() {
        assertEquals(song,MetadataMatch.track(local,listOf(song)))
        assertNull(MetadataMatch.track(local,listOf(song,song.copy(id="def456"))))
        assertNull(MetadataMatch.track(local,listOf(song.copy(title="Signal Live"))))
        assertNull(MetadataMatch.track(local,listOf(song.copy(artist="Someone Else"))))
        assertNull(MetadataMatch.track(local,listOf(song.copy(seconds=190.0))))
        assertNull(MetadataMatch.track(local.copy(artist="未知艺术家"),listOf(song)))
        assertFalse(MetadataMatch.album("Daylight","Orbit Studio","Daylight Deluxe",listOf("Orbit Studio")))
        assertTrue(MetadataMatch.album("日光 (Daylight)","Orbit Studio","Daylight",listOf("Orbit Studio")))
        assertTrue(MetadataMatch.album("光","岚","光",listOf("岚")))
        assertFalse(MetadataMatch.album("Signal (Live)","Orbit Studio","Signal",listOf("Orbit Studio")))
    }
    @Test fun responseLimitStopsUnboundedDownloads() {
        assertArrayEquals(byteArrayOf(1,2,3),MetadataResponse.read(byteArrayOf(1,2,3).inputStream(),3))
        assertThrows(IllegalArgumentException::class.java) { MetadataResponse.read(ByteArray(10000).inputStream(),32) }
    }
}
