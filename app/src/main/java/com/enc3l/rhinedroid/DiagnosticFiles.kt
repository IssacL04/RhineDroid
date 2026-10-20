package com.enc3l.rhinedroid

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Called by the single diagnostics worker; storage stays bounded between exports. */
internal class DiagnosticFiles(val directory: File, private val limit: Int = 256 * 1024) {
    init { directory.mkdirs() }
    fun append(line: String) {
        val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
        require(bytes.size <= limit)
        val current = File(directory, "events.jsonl")
        if (current.length() + bytes.size > limit) {
            val previous = File(directory, "events-previous.jsonl")
            previous.delete()
            check(current.renameTo(previous)) { "Cannot rotate diagnostics" }
        }
        current.appendBytes(bytes)
    }
    fun zip(output: File, diagnostics: String, logcat: File) {
        ZipOutputStream(output.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry("diagnostics.json"))
            zip.write(diagnostics.toByteArray(Charsets.UTF_8)); zip.closeEntry()
            listOf(File(directory, "events-previous.jsonl"), File(directory, "events.jsonl"), logcat)
                .filter { it.isFile }.forEach { file ->
                    zip.putNextEntry(ZipEntry(file.name))
                    file.inputStream().use { input ->
                        val length = file.length()
                        if (length > limit) input.skip(length - limit)
                        input.copyTo(zip)
                    }
                    zip.closeEntry()
                }
        }
    }
}
