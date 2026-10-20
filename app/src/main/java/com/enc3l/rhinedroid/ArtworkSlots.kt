package com.enc3l.rhinedroid

/** Stable texture addresses: scrolling never invalidates already loaded covers. */
internal class ArtworkSlots(private val capacity: Int = 256) {
    data class Entry(val id: String, val slot: Int, var ready: Boolean = false)
    private val entries = LinkedHashMap<String, Entry>(capacity, .75f, true)
    fun bind(ids: List<String>): List<Entry> {
        val wanted = ids.toSet()
        require(wanted.size <= capacity)
        return ids.distinct().map { id ->
            entries[id] ?: run {
                val slot = if (entries.size < capacity) (0 until capacity).first { n -> entries.values.none { it.slot == n } }
                else entries.remove(entries.keys.first { it !in wanted })!!.slot
                Entry(id, slot).also { entries[id] = it }
            }
        }
    }
    fun get(id: String) = entries[id]
    fun ready(id: String, slot: Int): Boolean = entries[id]?.takeIf { it.slot == slot }?.let { it.ready = true; true } ?: false
    fun clear() = entries.clear()
}
