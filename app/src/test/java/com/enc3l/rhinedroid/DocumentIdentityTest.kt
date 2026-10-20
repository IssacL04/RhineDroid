package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class DocumentIdentityTest {
    @Test fun documentIdsAreStableAndSeparateFromMediaStoreIds() {
        val ids=(0 until 10000).map { DocumentIdentity.id("content://fixture/document/music-$it") }
        assertEquals(10000,ids.toSet().size)
        assertTrue(ids.all { it>=(1L shl 62) })
        assertEquals(ids[10],DocumentIdentity.id("content://fixture/document/music-10"))
        assertTrue(DocumentIdentity.audio("track.FLAC","application/octet-stream"))
        assertFalse(DocumentIdentity.audio("cover.jpg","image/jpeg"))
    }
}
