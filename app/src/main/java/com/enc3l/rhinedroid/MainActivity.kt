package com.enc3l.rhinedroid

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.view.OrientationEventListener
import android.view.SurfaceView
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowInsetsControllerCompat
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import android.widget.Toast

class MainActivity : ComponentActivity() {
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private var archive: VulkanArchiveRenderer? = null
    private var errorView: android.view.View? = null
    private var rendererRecoveries = 0
    private var bridgeAvailable = false
    private lateinit var music: NativeMusicHost
    private var sensor: OrientationEventListener? = null
    private var fullscreen: Boolean? = null
    fun toggleImmersive() {
        fullscreen=!(fullscreen ?: (resources.configuration.orientation==Configuration.ORIENTATION_LANDSCAPE))
        systemBars()
    }
    private var logExport: File? = null
    private var preparingLog = false
    private val musicFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if(uri!=null) runCatching {
            contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)
            LibraryRepository.get(this).addTree(uri)
        }.onFailure { RhineLog.error("folder-permission",it); Toast.makeText(this,"无法保留文件夹读取权限，请重新选择",Toast.LENGTH_LONG).show() }
    }
    fun chooseMusicFolder() { musicFolder.launch(null) }
    private val saveLog = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val file = logExport
        logExport = null
        if (file != null) {
            if (uri == null) file.delete()
            else RhineLog.save(applicationContext, file, uri) { result ->
                result.onFailure { RhineLog.error("log-save", it) }
                if (!isDestroyed) Toast.makeText(this, if (result.isSuccess) "日志已保存，可将 ZIP 文件发回排查" else "保存失败，请重新导出", Toast.LENGTH_LONG).show()
            }
        }
    }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        music.permissionResult(granted)
    }
    private fun send(event: JSONObject) {
        if (isFinishing || isDestroyed) return
        webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('rhine-native',{detail:${event}}))", null)
    }
    private fun systemBars() {
        val bars = WindowCompat.getInsetsController(window, container)
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (fullscreen ?: (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE))
            bars.hide(WindowInsetsCompat.Type.systemBars())
        else bars.show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(container)
    }
    private fun publishOrientation() {
        val value = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait"
        webView?.evaluateJavascript("document.documentElement.dataset.orientation='$value'", null)
    }
    private fun rotate() {
        requestedOrientation = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        fullscreen=null
        RhineLog.event("configuration", JSONObject().put("orientation", newConfig.orientation)
            .put("widthDp", newConfig.screenWidthDp).put("heightDp", newConfig.screenHeightDp))
        systemBars()
        publishOrientation()
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::container.isInitialized) systemBars()
    }
    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            val view = webView ?: return finish()
            if (Uri.parse(view.url ?: "").path != "/index.html" && view.canGoBack()) {
                view.goBack()
                return
            }
            val insets = ViewCompat.getRootWindowInsets(container)
            if (insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                WindowCompat.getInsetsController(window, container).hide(WindowInsetsCompat.Type.ime())
                return
            }
            view.evaluateJavascript("window.rhineAndroid?.back() === true") { result ->
                if (!isFinishing && result != "true") finish()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        container = FrameLayout(this).apply { setBackgroundColor(ArchivePalette.color(0.0)) }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            // Use the destination bar sizes, so their show animation cannot resize Vulkan twice.
            val immersive = fullscreen ?: (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
            val safe = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.displayCutout() or
                (if (immersive) 0 else WindowInsetsCompat.Type.systemBars()))
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val left = maxOf(safe.left, ime.left); val top = maxOf(safe.top, ime.top)
            val right = maxOf(safe.right, ime.right); val bottom = maxOf(safe.bottom, ime.bottom)
            if (view.paddingLeft != left || view.paddingTop != top || view.paddingRight != right || view.paddingBottom != bottom)
                view.setPadding(left, top, right, bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        music = NativeMusicHost(this, ::send,
            { permission.launch(LibraryRepository.get(this).permission()) }, ::rotate)
        systemBars()
        // Start in landscape; unlock physical rotation only after the device moves.
        sensor = object : OrientationEventListener(this) {
            private var initial = -1
            override fun onOrientationChanged(angle: Int) {
                if (angle < 0) return
                val quadrant = ((angle + 45) / 90) % 4
                if (kotlin.math.abs(angle - quadrant * 90).let { minOf(it, 360 - it) } > 20) return
                if (initial < 0) initial = quadrant
                else if (quadrant != initial) {
                    initial = quadrant
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                }
            }
        }
        createInterface()
    }

    private fun createInterface() {
        errorView?.let(container::removeView); errorView = null
        if (archive == null) {
            val surface = SurfaceView(this)
            container.addView(surface, 0, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            try {
                archive = VulkanArchiveRenderer(this, surface, ::send, container::setBackgroundColor)
                archive?.resume()
                Log.i("RhineVulkan", "Native shelf backend: VULKAN; hardware instancing enabled")
            } catch (error: Throwable) {
                if (error !is RuntimeException && error !is LinkageError) throw error
                container.removeView(surface)
                Log.e("RhineVulkan", "Vulkan initialization failed", error)
                showError("Vulkan 渲染器无法启动：${error.message ?: error.javaClass.simpleName}。需要 Vulkan 1.1 硬件及可用的厂商驱动。")
                return
            }
        }
        createWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        backCallback.isEnabled = false
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val view = WebView(this)
        webView = view
        container.addView(view, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view.setBackgroundColor(Color.TRANSPARENT)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        bridgeAvailable = false
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            releaseWebView()
            showError("此 WebView 版本不支持音乐控制。请更新 Android System WebView 后重新打开。")
            return
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeAvailable = true
            WebViewCompat.addWebMessageListener(view, "RhineHost", setOf(ORIGIN)) {
                    _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && sourceOrigin.toString().trimEnd('/') == ORIGIN) {
                    val raw = message.data
                    if (raw != null && raw.length <= 524288) {
                        val state = runCatching { JSONObject(raw) }.getOrNull()
                        if (state != null && state.optString("type") != "ui-state") {
                            if (state.optString("type") == "export-log") {
                                exportLog(state.optJSONObject("diagnostics") ?: JSONObject())
                                send(JSONObject().put("type", "response").put("id", state.optInt("id")))
                            } else if (state.optString("type").startsWith("scene-")) {
                                val reply = JSONObject().put("type", "response").put("id", state.optInt("id"))
                                try {
                                    checkNotNull(archive) { "Vulkan 渲染器不可用" }.command(state)
                                } catch (error: Exception) {
                                    RhineLog.error("scene-command", error)
                                    reply.put("error", error.message ?: "Vulkan 场景操作失败")
                                }
                                send(reply)
                            } else music.command(state)
                        } else if (state?.optString("type") == "ui-state") {
                            backCallback.isEnabled = state.optBoolean("canGoBack")
                            val night = state.optString("theme") == "night"
                            if (archive == null) container.setBackgroundColor(ArchivePalette.color(if (night) 1.0 else 0.0))
                            WindowCompat.getInsetsController(window, container).apply {
                                isAppearanceLightStatusBars = !night
                                isAppearanceLightNavigationBars = !night
                            }
                        }
                    }
                }
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING)
                    RhineLog.event("web-console", JSONObject().put("level", message.messageLevel().name)
                        .put("message", message.message().take(2000)).put("source", message.sourceId()).put("line", message.lineNumber()))
                return true
            }
        }
        view.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                return if (isLocal(request.url)) music.resource(request.url.path ?: "") ?: loader.shouldInterceptRequest(request.url) ?: missing()
                else missing()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isLocal(request.url)) return false
                if (request.isForMainFrame && request.url.scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                publishOrientation()
                // shortcut: old WebViews lack state messages; use JS on Back until WebView is updated.
                if (!bridgeAvailable || Uri.parse(url).path != "/index.html") backCallback.isEnabled = true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                RhineLog.event("web-process-gone", JSONObject().put("crashed", detail.didCrash()))
                releaseWebView()
                if (!isFinishing && rendererRecoveries++ < 1) createWebView()
                else showError("图形进程已停止。请更新 Android System WebView，或重试打开界面。")
                return true
            }
        }
        view.loadUrl("$ORIGIN/index.html?renderer=vulkan&version=${Uri.encode(BuildConfig.VERSION_NAME)}" +
            if (BuildConfig.EXPERIMENTAL_OPTICS) "&optics=rc" else "")
    }

    private fun showError(message: String) {
        RhineLog.event("interface-error", JSONObject().put("message", message))
        backCallback.isEnabled = false
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(TextView(this@MainActivity).apply { text = message; textSize = 18f })
            addView(Button(this@MainActivity).apply {
                text = "重新打开"
                setOnClickListener { releaseWebView(); createInterface() }
            })
            addView(Button(this@MainActivity).apply {
                text = "导出运行日志"
                setOnClickListener { exportLog(JSONObject()) }
            })
        }
        errorView?.let(container::removeView)
        errorView = layout
        layout.setBackgroundColor(Color.rgb(232, 229, 225))
        container.addView(layout, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun releaseWebView() {
        val view = webView ?: return
        webView = null
        backCallback.isEnabled = false
        container.removeView(view)
        view.destroy()
    }

    private fun exportLog(ui: JSONObject) {
        if (preparingLog || logExport != null) return
        preparingLog = true
        val diagnostics = JSONObject().put("ui", ui).put("vulkan", archive?.snapshot())
            .put("orientation", resources.configuration.orientation)
            .put("window", JSONObject().put("width", container.width).put("height", container.height)
                .put("paddingTop", container.paddingTop).put("paddingBottom", container.paddingBottom))
        RhineLog.event("log-export")
        RhineLog.export(applicationContext, diagnostics) { result ->
            preparingLog = false
            result.onSuccess { file ->
                if (isDestroyed) file.delete()
                else {
                    logExport = file
                    runCatching {
                        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
                        saveLog.launch("RhineDroid-logs-$stamp.zip")
                    }.onFailure {
                        logExport = null; file.delete(); RhineLog.error("log-save-dialog", it)
                        Toast.makeText(this, "无法打开文件选择器", Toast.LENGTH_LONG).show()
                    }
                }
            }.onFailure {
                RhineLog.error("log-export", it)
                if (!isDestroyed) Toast.makeText(this, "日志导出失败，请重试", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onPause() {
        RhineLog.event("activity-pause")
        webView?.evaluateJavascript("window.rhineAndroid?.suspend()", null)
        webView?.onPause()
        archive?.pause()
        music.pause()
        sensor?.disable()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        RhineLog.event("activity-resume")
        webView?.onResume()
        archive?.resume()
        music.resume()
        sensor?.enable()
        systemBars()
        webView?.evaluateJavascript("window.rhineAndroid?.resume()", null)
    }

    override fun onDestroy() {
        sensor?.disable()
        music.close()
        releaseWebView()
        archive?.close(); archive = null
        super.onDestroy()
    }

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private fun isLocal(uri: Uri) = uri.scheme == "https" &&
            uri.host == "appassets.androidplatform.net" && uri.port == -1
        private fun missing() = WebResourceResponse("text/plain", "UTF-8", 404,
            "Not Found", emptyMap(), ByteArrayInputStream("Not Found".toByteArray()))
    }
}
