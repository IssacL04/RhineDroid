package com.enc3l.rhinedroid

internal data class IndexedSong(val id: Long, val albumId: Long, val title: String, val artist: String,
    val album: String, val durationMs: Long, val number: Int, val year: Int, val filename: String, val modified: Long, val genre: String = "", val composer: String = "", val albumArtist: String = "", val bitrate: Long = 0) {
    val disc get() = (number / 1000).coerceAtLeast(1)
    val track get() = number % 1000
}

/** One pass over system rows, then a sort within each album. No file IO. */
internal class MusicIndex {
    private val groups = linkedMapOf<Long, MutableList<IndexedSong>>()
    private val ids = hashSetOf<Long>()
    var count = 0
        private set
    fun add(song: IndexedSong) {
        if (song.id < 0 || song.durationMs <= 0 || !ids.add(song.id)) return
        groups.getOrPut(song.albumId) { mutableListOf() }.add(song)
        count++
    }
    fun albums(): Collection<List<IndexedSong>> = groups.values.map { songs ->
        songs.sortedWith(compareBy<IndexedSong> { it.disc }.thenBy { it.track }.thenBy { it.title })
    }
}
