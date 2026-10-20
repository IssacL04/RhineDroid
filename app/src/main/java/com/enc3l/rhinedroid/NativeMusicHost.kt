package com.enc3l.rhinedroid

import android.content.ComponentName
import android.database.ContentObserver
import android.provider.MediaStore
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceResponse
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** Only the Activity's origin-checked message listener can call these commands. */
class NativeMusicHost(private val activity: MainActivity, private val send: (JSONObject) -> Unit,
    private val requestPermission: () -> Unit, private val rotate: () -> Unit) {
    private val repository = LibraryRepository.get(activity)
    private val catalog = (activity.application as RhineApplication).catalog
    private val handler = Handler(Looper.getMainLooper())
    private val future = MediaController.Builder(activity, SessionToken(activity,
        ComponentName(activity, PlaybackService::class.java))).buildAsync()
    private var controller: MediaController? = null
    private var closed = false
    private var visible = false
    private var playbackError: String? = null
    private var queueDirty = true
    private var requestedVolume = 0.65f
    private var audioConfig: JSONObject? = null
    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.size() == 1 && events.contains(Player.EVENT_VOLUME_CHANGED)) return
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) queueDirty = true
            publish()
        }
        override fun onPlayerError(error: PlaybackException) {
            RhineLog.error("audio-playback", error)
            playbackError = "无法播放此音频（${error.errorCodeName}）。请确认文件仍存在且格式受设备支持。"
            publish()
        }
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) { playbackError = null }
    }
    private val refresh = Runnable { if (!closed && repository.permitted()) repository.scan() }
    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) {
            handler.removeCallbacks(refresh); handler.postDelayed(refresh, 1200)
        }
    }
    private val tick = object : Runnable {
        override fun run() { if (visible && !closed) { publish(); handler.postDelayed(this, 500) } }
    }
    init {
        activity.contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer)
        catalog.onChanged = { handler.post { if(!closed) send(JSONObject().put("type","metadata-updated")) } }
        repository.onChanged = { event -> handler.post { if (!closed) send(event) } }
        future.addListener({
            if (!closed) try {
                controller = future.get().also { if (it.currentMediaItem == null) it.volume = requestedVolume; it.addListener(listener) }
                audioConfig?.let { PlaybackService.instance?.configure(it) }
                PlaybackService.instance?.foreground(visible)
                publish()
            } catch (_: Exception) { send(JSONObject().put("type", "error").put("error", "音频服务连接失败，请重新打开应用。")) }
        }, ContextCompat.getMainExecutor(activity))
    }
    fun resource(path: String): WebResourceResponse? {
        if (path == "/native/library") {
            val bytes = repository.library().toString().toByteArray(Charsets.UTF_8)
            return WebResourceResponse("application/json", "UTF-8", 200, "OK",
                mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))
        }
        if (path.startsWith("/native/cover/")) {
            val id = path.removePrefix("/native/cover/").toLongOrNull() ?: return null
            val bytes = repository.cover(id) ?: return null
            return WebResourceResponse("image/jpeg", null, 200, "OK", mapOf("Cache-Control" to "private, max-age=3600"), ByteArrayInputStream(bytes))
        }
        return null
    }
    fun command(message: JSONObject) {
        val id = message.optInt("id", 0)
        if(message.optString("type")=="library-api") {
            catalog.api(message) { result ->
                if(!closed) send(JSONObject().put("type","response").put("id",id).also { reply ->
                    result.onSuccess { reply.put("result",it) }.onFailure { reply.put("error",it.message?:"资料操作失败") }
                })
            }
            return
        }
        try {
            val action = message.getString("type")
            RhineLog.event("music-command", JSONObject().put("action", action))
            when (action) {
                "ready" -> {
                    val volume = message.optDouble("volume", 0.65)
                    require(volume.isFinite() && volume in 0.0..1.0)
                    requestedVolume = volume.toFloat()
                    audioConfig=JSONObject(message.toString())
                    PlaybackService.instance?.configure(message)
                    controller?.let { if (it.currentMediaItem == null) it.volume = requestedVolume }
                    queueDirty = true; publish(); if (repository.permitted()) repository.scan()
                }
                "audio-settings" -> { checkNotNull(PlaybackService.instance) { "音频服务正在连接" }.configure(message); publish() }
                "audio-outputs" -> publish()
                "scan" -> if (repository.mediaPermitted()) repository.scan() else requestPermission()
                "choose-folder" -> activity.chooseMusicFolder()
                "remove-folder" -> repository.removeTree(message.getString("uri"))
                "cancel-scan" -> repository.cancel()
                "orientation" -> rotate()
                "fullscreen" -> activity.toggleImmersive()
                "app-settings" -> activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:${activity.packageName}")))
                "play" -> {
                    val player = controller ?: error("音频服务正在连接，请稍后重试。")
                    check(repository.permitted()) { "请先授权并扫描音乐库。" }
                    val input = message.getJSONArray("tracks")
                    require(input.length() in 1..10000) { "播放队列大小无效。" }
                    val ids = (0 until input.length()).map { input.getString(it) }.distinct()
                    val selected = ids.indexOf(message.getString("trackId"))
                    val available=repository.playableTrackIds()
                    require(selected >= 0 && ids.all { it in available }) { "曲目已不在曲库中，请重新扫描。" }
                    playbackError = null
                    val next = { player.setMediaItems(ids.map { MediaItem.Builder().setMediaId(it).build() }, selected, 0); player.prepare(); player.play() }
                    checkNotNull(PlaybackService.instance) { "音频服务正在连接" }.switchTrack(next)
                }
                "toggle" -> { PlaybackService.instance?.cancelTransition(); withPlayer { if (isPlaying || playWhenReady) pause() else {
                    if (playbackState == Player.STATE_IDLE) prepare()
                    if (playbackState == Player.STATE_ENDED) seekTo(0)
                    play()
                } } }
                "stop" -> withPlayer { PlaybackService.instance?.cancelTransition(); pause(); seekTo(0); stop(); clearMediaItems(); playbackError = null }
                "seek" -> {
                    val seconds = message.getDouble("seconds")
                    require(seconds.isFinite() && seconds >= 0)
                    withPlayer { if (duration > 0) seekTo((seconds * 1000).toLong().coerceIn(0, duration)) }
                }
                "next" -> withPlayer { if (hasNextMediaItem()) PlaybackService.instance?.switchTrack { seekToNextMediaItem() } }
                "previous" -> withPlayer { PlaybackService.instance?.switchTrack { seekToPrevious() } }
                "volume" -> {
                    val volume = message.getDouble("volume")
                    require(volume.isFinite() && volume in 0.0..1.0)
                    requestedVolume = volume.toFloat()
                    PlaybackService.instance?.configure(JSONObject().put("volume",volume)); publish()
                }
                else -> error("未知的原生命令。")
            }
            if (id > 0) send(JSONObject().put("type", "response").put("id", id).put("ok", true))
        } catch (error: Exception) {
            RhineLog.error("music-command", error)
            send(JSONObject().put("type", if (id > 0) "response" else "error").put("id", id)
                .put("error", error.localizedMessage ?: "操作失败，请重试。"))
        }
    }
    private fun withPlayer(action: MediaController.() -> Unit) { (controller ?: error("音频服务正在连接。请稍后重试。")).action(); publish() }
    fun permissionResult(granted: Boolean) {
        RhineLog.event("music-permission", JSONObject().put("granted", granted))
        if (granted) repository.scan()
        else send(JSONObject().put("type", "library-status").put("running", false)
            .put("error", "未获得音乐权限。可在系统应用设置中允许读取音乐后重试。"))
    }
    fun publish() {
        val player = controller ?: return
        val current = player.currentMediaItem
        val error = playbackError ?: player.playerError?.let { "无法播放此音频（${it.errorCodeName}）。请检查文件或重新扫描。" }
        val queue = if (queueDirty) JSONArray().also { list ->
            for (i in 0 until player.mediaItemCount) list.put(player.getMediaItemAt(i).mediaId)
        } else null
        queueDirty = false
        val audio=PlaybackService.instance?.state()
        send(JSONObject().put("type", "player").put("track", current?.let { repository.track(it.mediaId) } ?: JSONObject.NULL)
            .put("queue", queue).put("currentIndex", player.currentMediaItemIndex)
            .put("playing", player.isPlaying).put("loading", player.playbackState == Player.STATE_BUFFERING)
            .put("transport", when {
                error != null -> "error"
                current == null -> "idle"
                player.playbackState == Player.STATE_BUFFERING -> "loading"
                player.isPlaying -> "playing"
                else -> "paused"
            }).put("currentTime", player.currentPosition.coerceAtLeast(0) / 1000.0)
            .put("duration", if (player.duration != C.TIME_UNSET) player.duration.coerceAtLeast(0) / 1000.0 else 0)
            .put("volume", audio?.optDouble("volume",requestedVolume.toDouble()) ?: requestedVolume.toDouble())
            .put("audio",audio).put("error", error ?: JSONObject.NULL))
    }
    fun resume() { visible = true; PlaybackService.instance?.foreground(true); handler.removeCallbacks(tick); handler.post(tick) }
    fun pause() { visible = false; PlaybackService.instance?.foreground(false); handler.removeCallbacks(tick) }
    fun close() {
        closed = true; pause(); repository.onChanged = null; catalog.onChanged = null
        handler.removeCallbacks(refresh)
        activity.contentResolver.unregisterContentObserver(observer)
        controller?.removeListener(listener)
        MediaController.releaseFuture(future)
    }
}
