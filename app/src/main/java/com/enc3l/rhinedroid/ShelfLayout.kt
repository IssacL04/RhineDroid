package com.enc3l.rhinedroid

/** Fixed GPU slots; library size never increases per-frame submission work. */
internal object ShelfLayout {
    const val COLUMNS = 7
    const val ROWS = 31
    const val COUNT = COLUMNS * ROWS
    const val SELECTED = COUNT / 2
    const val INTRO_COLUMNS = 9
    const val INTRO_ROWS = 49
    const val INTRO_COUNT = INTRO_COLUMNS * INTRO_ROWS
    data class Cell(val lane: Int, val row: Int, val album: String?, val x: Float, val z: Float, val physicalLane: Int, val physicalRow: Int)
    fun cells(columns: List<List<String>>, lane: Int, row: Int, filled: Boolean): List<Cell> {
        return List(COUNT) { slot ->
            val dx = slot / ROWS - COLUMNS / 2
            val dz = slot % ROWS - ROWS / 2
            val column = if (filled && columns.isNotEmpty()) Math.floorMod(lane + dx, columns.size) else lane + dx
            val songs = columns.getOrNull(column).orEmpty()
            val center = if (filled || column == lane) row.toFloat() else (songs.size - 1) / 2f
            val raw = kotlin.math.round(center).toInt() + dz
            val item = if (filled && songs.isNotEmpty()) Math.floorMod(raw, songs.size) else raw
            Cell(column, item, songs.getOrNull(item), dx * 5.2f, (raw - center) * 0.62f, lane + dx, raw)
        }
    }
}
