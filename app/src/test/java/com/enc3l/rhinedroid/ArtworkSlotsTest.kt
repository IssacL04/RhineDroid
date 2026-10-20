package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class ArtworkSlotsTest {
    @Test fun slidingKeepsLoadedCoversAndTheirTextureAddresses() {
        val slots = ArtworkSlots(8)
        val first = slots.bind(listOf("a", "b", "c"))
        first.forEach { assertTrue(slots.ready(it.id, it.slot)) }
        val next = slots.bind(listOf("b", "c", "d"))
        assertSame(first[1], next[0]); assertSame(first[2], next[1])
        assertTrue(next[0].ready); assertTrue(next[1].ready); assertFalse(next[2].ready)
    }
    @Test fun evictionNeverInvalidatesTheVisibleSetOrAcceptsAnOldUpload() {
        val slots = ArtworkSlots(4)
        val a = slots.bind(listOf("a", "b", "c", "d"))[0]
        slots.bind(listOf("b", "c", "d", "e")).forEach { slots.ready(it.id, it.slot) }
        assertNull(slots.get("a")); assertFalse(slots.ready("a", a.slot))
        assertEquals(a.slot, slots.get("e")!!.slot)
        assertTrue(listOf("b", "c", "d", "e").all { slots.get(it)!!.ready })
        for (n in 0..1000) {
            val visible = slots.bind(List(4) { "${n + it}" })
            assertEquals(4, visible.map { it.slot }.toSet().size)
        }
    }
}
