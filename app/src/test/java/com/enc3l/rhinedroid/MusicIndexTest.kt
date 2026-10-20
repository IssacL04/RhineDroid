package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class MusicIndexTest {
    private fun song(id: Long, album: Long = id / 10, number: Int = (id % 10).toInt() + 1, duration: Long = 180000) =
        IndexedSong(id, album, "Song $id", "Artist", "Album $album", duration, number, 2026, "$id.flac", 1)

    @Test fun tenThousandTracksKeepStableIdentityAndSortWithoutFileIO() {
        val start = System.nanoTime()
        val index = MusicIndex()
        for (id in 9999L downTo 0L) index.add(song(id))
        val albums = index.albums()
        assertEquals(10000, index.count)
        assertEquals(1000, albums.size)
        assertEquals(10000, albums.flatten().map { it.id }.toSet().size)
        for (album in albums) assertEquals((1..10).toList(), album.map { it.track })
        println("Synthetic 10k index grouping/sort: ${(System.nanoTime() - start) / 1_000_000} ms; excludes provider, storage and artwork")
    }
    @Test fun duplicateInvalidAndMultiDiscRowsAreHandled() {
        val index = MusicIndex()
        index.add(song(1, 1, 2001)); index.add(song(2, 1, 1002)); index.add(song(3, 1, 1001))
        index.add(song(1, 1)); index.add(song(4, 1, duration = 0)); index.add(song(-1, 1))
        assertEquals(3, index.count)
        assertEquals(listOf(3L, 2L, 1L), index.albums().single().map { it.id })
    }
    @Test fun emptyLibraryIsAValidResult() { assertTrue(MusicIndex().albums().isEmpty()) }
}
