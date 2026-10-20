package com.enc3l.rhinedroid

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal object RhineLog {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var files: DiagnosticFiles
    fun init(context: Context) {
        files = DiagnosticFiles(File(context.filesDir, "diagnostics"))
        event("process-start", JSONObject().put("version", BuildConfig.VERSION_NAME).put("pid", Process.myPid()))
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            RhineLog.error("uncaught-exception", error)
            runCatching { worker.submit {}.get(500, TimeUnit.MILLISECONDS) }
            previous?.uncaughtException(thread, error)
        }
    }
    fun event(type: String, data: JSONObject = JSONObject()) {
        val bounded = if (data.toString().length > 8192) JSONObject().put("truncated", data.toString().take(6000)) else data
        val line = JSONObject().put("time", System.currentTimeMillis()).put("event", type).put("data", bounded).toString()
        worker.execute { runCatching { files.append(line) }.onFailure { Log.w("RhineLog", "Cannot save diagnostics", it) } }
    }
    fun error(type: String, error: Throwable) {
        Log.e("Rhine", type, error)
        event(type, JSONObject().put("error", error.toString().take(1024)).put("stack", Log.getStackTraceString(error).take(5000)))
    }
    fun export(context: Context, diagnostics: JSONObject, done: (Result<File>) -> Unit) {
        val report = JSONObject().put("version", BuildConfig.VERSION_NAME).put("versionCode", BuildConfig.VERSION_CODE)
            .put("time", System.currentTimeMillis()).put("device", JSONObject().put("manufacturer", Build.MANUFACTURER)
                .put("model", Build.MODEL).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                .put("securityPatch", Build.VERSION.SECURITY_PATCH).put("abis", Build.SUPPORTED_ABIS.joinToString())
                .put("soc", if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else "unknown"))
            .put("state", diagnostics).toString(2)
        val cache = File(context.cacheDir, "diagnostic-exports")
        worker.execute {
            val result = runCatching {
                cache.mkdirs()
                cache.listFiles()?.sortedByDescending { it.lastModified() }?.drop(2)?.forEach { it.delete() }
                val logcat = File.createTempFile("logcat-", ".txt", cache)
                val output = File.createTempFile("Rhine-logs-", ".zip", cache)
                try {
                    runCatching {
                        val process = ProcessBuilder("logcat", "-d", "--pid=${Process.myPid()}", "-t", "600", "-v", "threadtime")
                            .redirectErrorStream(true).redirectOutput(logcat).start()
                        if (!process.waitFor(3, TimeUnit.SECONDS)) { process.destroyForcibly(); logcat.appendText("\nlogcat timed out") }
                    }.onFailure { logcat.writeText("logcat unavailable: ${it.javaClass.simpleName}") }
                    // Keep a fixed entry name so users can inspect the ZIP without special tools.
                    val namedLogcat = File(cache, "logcat.txt")
                    check(logcat.renameTo(namedLogcat))
                    try { files.zip(output, report, namedLogcat) } finally { namedLogcat.delete() }
                    output
                } catch (error: Exception) { output.delete(); throw error }
                finally { logcat.delete() }
            }
            main.post { done(result) }
        }
    }
    fun save(context: Context, file: File, uri: android.net.Uri, done: (Result<Unit>) -> Unit) {
        worker.execute {
            val result = runCatching {
                checkNotNull(context.contentResolver.openOutputStream(uri, "wt")) { "无法写入所选文件" }.use { output ->
                    file.inputStream().use { it.copyTo(output) }
                }
                Unit
            }.onFailure { runCatching { android.provider.DocumentsContract.deleteDocument(context.contentResolver, uri) } }
            file.delete()
            main.post { done(result) }
        }
    }
}
