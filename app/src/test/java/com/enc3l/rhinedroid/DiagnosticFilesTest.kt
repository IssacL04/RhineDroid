package com.enc3l.rhinedroid

import java.io.File
import java.nio.file.Files
import java.util.zip.ZipFile
import org.junit.Assert.*
import org.junit.Test

class DiagnosticFilesTest {
    @Test fun rotatingLogAndExportRemainBoundedAndReadable() {
        val dir = Files.createTempDirectory("rhine-log-test").toFile()
        try {
            val files = DiagnosticFiles(File(dir, "events"), 256)
            for (i in 0..100) files.append("{\"event\":\"selection\",\"number\":$i}")
            assertEquals(2, files.directory.listFiles()!!.size)
            assertTrue(files.directory.listFiles()!!.all { it.length() <= 256 })
            val logcat = File(dir, "logcat.txt").apply { writeText("a".repeat(1000) + "recent error") }
            val output = File(dir, "export.zip")
            files.zip(output, "{\"version\":\"test\"}", logcat)
            ZipFile(output).use { zip ->
                assertEquals(setOf("diagnostics.json", "events-previous.jsonl", "events.jsonl", "logcat.txt"), zip.entries().asSequence().map { it.name }.toSet())
                fun text(name: String) = zip.getInputStream(zip.getEntry(name)).bufferedReader().use { it.readText() }
                assertEquals("{\"version\":\"test\"}", text("diagnostics.json"))
                assertTrue(text("events.jsonl").contains("100"))
                assertTrue(text("logcat.txt").endsWith("recent error"))
                assertEquals(256, zip.getEntry("logcat.txt").size.toInt())
            }
        } finally { dir.deleteRecursively() }
    }
}
