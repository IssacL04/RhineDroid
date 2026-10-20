package com.enc3l.rhinedroid

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private lateinit var audio: ExoPlayer
    private lateinit var bgm: ExoPlayer
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val songGain = AudioEnvelope()
    private val backgroundGain = AudioEnvelope(0f)
    private val prefs by lazy { getSharedPreferences("playback", MODE_PRIVATE) }
    private var visible = false
    private var pending: (() -> Unit)? = null
    private var switchAt = 0L
    private var fadeWaiting = false
    private var ticking = false
    private var closing=false
    private val manager by lazy { getSystemService(android.media.AudioManager::class.java) }
    private val devices = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesRemoved(removed: Array<out android.media.AudioDeviceInfo>) {
            if (removed.any { it.id.toString() == prefs.getString("outputDevice", "default") }) {
                prefs.edit().putString("outputDevice", "default").apply(); route("default")
            }
        }
    }
    private val fadeTick = object : Runnable {
        override fun run() {
            ticking = false
            val now = android.os.SystemClock.uptimeMillis()
            if (pending != null && now >= switchAt) { val next=pending; pending=null; next?.invoke() }
            audio.volume = prefs.getFloat("volume",.65f)*songGain.sample(now)
            bgm.volume = prefs.getFloat("bgmVolume",.18f)*backgroundGain.sample(now)
            if (backgroundGain.target == 0f && backgroundGain.settled(now)) bgm.pause()
            if (pending != null || !songGain.settled(now) || !backgroundGain.settled(now)) schedule()
        }
    }
    private fun schedule() { if (!closing && !ticking) { ticking=true; handler.postDelayed(fadeTick,16) } }
    private fun updateBackground() {
        if(closing) return
        val allowed = visible && prefs.getBoolean("bgm",false) && audio.currentMediaItem == null && pending == null
        val now = android.os.SystemClock.uptimeMillis()
        val target = if (allowed) 1f else 0f
        if (backgroundGain.target != target) backgroundGain.to(target,now,if (allowed) 1200 else 450)
        if (allowed && !bgm.isPlaying) { if(bgm.playbackState==androidx.media3.common.Player.STATE_IDLE) bgm.prepare(); bgm.play() }
        schedule()
    }
    fun foreground(value: Boolean) { visible=value; updateBackground() }
    fun configure(message: org.json.JSONObject) {
        val edit = prefs.edit()
        for (key in listOf("volume","bgmVolume")) if (message.has(key)) {
            val value=message.getDouble(key); require(value.isFinite() && value in 0.0..1.0); edit.putFloat(key,value.toFloat())
        }
        if (message.has("bgm")) edit.putBoolean("bgm",message.getBoolean("bgm"))
        if (message.has("songTransition")) {
            val mode=message.getString("songTransition"); require(mode in listOf("fade-out","fade-in-out","gapless")); edit.putString("songTransition",mode)
        }
        if (message.has("outputDevice")) route(message.getString("outputDevice"))
        edit.apply(); updateBackground(); schedule()
    }
    fun outputs(): org.json.JSONArray = org.json.JSONArray().put(org.json.JSONObject().put("id","default").put("name","跟随系统输出"))
        .also { list -> runCatching { manager.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).forEach { device ->
            list.put(org.json.JSONObject().put("id",device.id.toString()).put("name",device.productName.toString().ifBlank { "音频设备 ${device.id}" }))
        } }.onFailure { RhineLog.error("audio-devices",it) } }
    private fun route(id: String) {
        val device = if (id == "default") null else manager.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { it.id.toString() == id } ?: error("输出设备已断开，请刷新设备列表")
        audio.setPreferredAudioDevice(device); bgm.setPreferredAudioDevice(device)
        prefs.edit().putString("outputDevice",id).apply()
    }
    fun state(): org.json.JSONObject = org.json.JSONObject().put("songTransition",prefs.getString("songTransition","fade-in-out"))
        .put("volume",prefs.getFloat("volume",.65f)).put("bgm",prefs.getBoolean("bgm",false))
        .put("bgmVolume",prefs.getFloat("bgmVolume",.18f)).put("bgmPlaying",bgm.isPlaying)
        .put("outputDevice",prefs.getString("outputDevice","default")).put("outputDevices",outputs())
    fun switchTrack(action: () -> Unit) {
        val now=android.os.SystemClock.uptimeMillis()
        val mode=prefs.getString("songTransition","fade-in-out")
        fadeWaiting=false
        val next = {
            bgm.pause(); backgroundGain.to(0f,android.os.SystemClock.uptimeMillis(),0)
            val fade=mode=="fade-in-out"
            songGain.to(if(fade)0f else 1f,android.os.SystemClock.uptimeMillis(),0)
            audio.volume=prefs.getFloat("volume",.65f)*songGain.target
            fadeWaiting=fade
            runCatching(action).onFailure { RhineLog.error("audio-switch",it); fadeWaiting=false; songGain.to(1f,android.os.SystemClock.uptimeMillis(),0) }
            if (audio.isPlaying && fadeWaiting) { fadeWaiting=false; songGain.to(1f,android.os.SystemClock.uptimeMillis(),450) }
            schedule()
        }
        val fade = mode!="gapless" && (audio.isPlaying || pending!=null || bgm.isPlaying)
        pending=null
        if (fade) {
            songGain.to(0f,now,450); backgroundGain.to(0f,now,450)
            switchAt=now+450; pending=next; schedule()
        } else next()
    }
    fun cancelTransition() { pending=null; fadeWaiting=false; songGain.to(1f,android.os.SystemClock.uptimeMillis(),0); schedule() }
    companion object { var instance: PlaybackService? = null; private set }

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            setHandleAudioBecomingNoisy(true)
            setWakeMode(C.WAKE_MODE_LOCAL)
        }
        audio = player
        instance = this
        bgm = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),true)
            setHandleAudioBecomingNoisy(true)
            setMediaItem(MediaItem.fromUri("asset:///audio/observatory-preview.mp3"))
            repeatMode = androidx.media3.common.Player.REPEAT_MODE_ONE
            volume = 0f
        }
        player.volume=prefs.getFloat("volume",.65f)
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying && fadeWaiting) { fadeWaiting=false; songGain.to(1f,android.os.SystemClock.uptimeMillis(),450); schedule() }
            }
            override fun onEvents(player: androidx.media3.common.Player, events: androidx.media3.common.Player.Events) {
                if (events.size()!=1 || !events.contains(androidx.media3.common.Player.EVENT_VOLUME_CHANGED)) updateBackground()
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) { RhineLog.error("audio-service",error); cancelTransition() }
        })
        bgm.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) { RhineLog.error("background-audio",error) }
        })
        manager.registerAudioDeviceCallback(devices,handler)
        runCatching { route(prefs.getString("outputDevice","default") ?: "default") }.onFailure { route("default") }
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player).setSessionActivity(activity)
            .setCallback(object : MediaSession.Callback {
                @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
                override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                    return if (controller.packageName == packageName || controller.isTrusted)
                        super.onConnect(session, controller) else MediaSession.ConnectionResult.reject()
                }
                override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo,
                    mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> {
                    val library = LibraryRepository.get(this@PlaybackService)
                    return Futures.immediateFuture(library.mediaItems(mediaItems.map { it.mediaId }))
                }
            }).build()
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session
    override fun onDestroy() {
        closing=true; instance = null
        handler.removeCallbacksAndMessages(null)
        manager.unregisterAudioDeviceCallback(devices)
        bgm.release()
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }
}
