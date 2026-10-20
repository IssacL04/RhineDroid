package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class ShelfLayoutTest {
    @Test fun poolRemainsBoundedForTenThousandAlbums() {
        val albums = List(10000) { "device-album-$it" }
        val cells = ShelfLayout.cells(listOf(albums), 0, 9999, true)
        assertEquals(217, cells.size)
        assertTrue(cells.size <= 256)
        assertTrue(cells.size * 4 * 16 + 512 <= 16384)
        assertEquals("device-album-9999", cells[ShelfLayout.SELECTED].album)
        assertTrue(cells.all { it.album != null })
        assertEquals("device-album-0", cells[ShelfLayout.SELECTED + 1].album)
    }
    @Test fun finiteColumnsNeverWrapTheirFirstAndLastRows() {
        val cells = ShelfLayout.cells(listOf(listOf("a", "b")), 0, 0, false)
        assertNull(cells[ShelfLayout.SELECTED - 1].album)
        assertEquals("a", cells[ShelfLayout.SELECTED].album)
        assertEquals("b", cells[ShelfLayout.SELECTED + 1].album)
        assertNull(cells[ShelfLayout.SELECTED + 2].album)
    }
    @Test fun finiteColumnsKeepTheirOwnRowsAndNeverRepeatAcrossLanes() {
        val albums = listOf(List(10000) { "a$it" }, List(3) { "b$it" })
        val cells = ShelfLayout.cells(albums, 0, 9999, false)
        assertEquals("a9999", cells[ShelfLayout.SELECTED].album)
        assertEquals("b1", cells[ShelfLayout.SELECTED + ShelfLayout.ROWS].album)
        assertEquals(19, cells.count { it.album != null })
        val ids = cells.mapNotNull { it.album }
        assertEquals(ids.size, ids.toSet().size)
    }
    @Test fun emptyLibraryAndColumnTransitionsKeepStableSlotCoordinates() {
        assertTrue(ShelfLayout.cells(emptyList(), 0, 0, true).all { it.album == null })
        val cells = ShelfLayout.cells(listOf(listOf("a"), listOf("b")), 1, 0, true)
        assertEquals("b", cells[ShelfLayout.SELECTED].album)
        assertEquals("a", cells[ShelfLayout.SELECTED + ShelfLayout.ROWS].album)
        assertEquals(0f, cells[ShelfLayout.SELECTED].x, 0f)
        assertEquals(0f, cells[ShelfLayout.SELECTED].z, 0f)
    }
}
