package com.enc3l.rhinedroid

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.MediaStore
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/** MediaStore already indexes tags; scanning never decodes a song or its artwork. */
class LibraryRepository internal constructor(private val context: Context) {
    private val executor = Executors.newSingleThreadExecutor()
    private val cache = AtomicFile(File(context.filesDir, "library-v2.json"))
    @Volatile private var snapshot: JSONObject? = null
    @Volatile private var albums: Map<String, JSONObject> = emptyMap()
    @Volatile private var tracks: Map<String, JSONObject> = emptyMap()
    @Volatile private var scanning = false
    @Volatile private var coverVersions: Map<Long, Long> = emptyMap()
    private var artworkWrites = 0
    @Volatile private var cancellation: CancellationSignal? = null
    @Volatile private var rescanRequested = false
    var onChanged: ((JSONObject) -> Unit)? = null

    private val preferences = context.getSharedPreferences("library",Context.MODE_PRIVATE)
    fun mediaPermitted() = ContextCompat.checkSelfPermission(context, permission()) == PackageManager.PERMISSION_GRANTED
    fun trees(): List<Uri> = preferences.getStringSet("trees",emptySet()).orEmpty().map(Uri::parse).filter { uri ->
        context.contentResolver.persistedUriPermissions.any { it.uri==uri && it.isReadPermission }
    }
    fun permitted() = mediaPermitted() || trees().isNotEmpty()
    private fun access(): (JSONObject)->Boolean {
        val media=mediaPermitted(); val roots=trees().map { it.toString() }.toSet()
        return { album -> if(album.has("treeUri")) album.optString("treeUri") in roots else media }
    }
    private fun allowed(album: JSONObject)=access()(album)
    fun addTree(uri: Uri) {
        require(uri.scheme=="content" && context.contentResolver.persistedUriPermissions.any { it.uri==uri && it.isReadPermission })
        preferences.edit().putStringSet("trees",preferences.getStringSet("trees",emptySet()).orEmpty()+uri.toString()).apply()
        scan()
    }
    fun removeTree(value: String) {
        val previous=preferences.getStringSet("trees",emptySet()).orEmpty(); require(value in previous)
        preferences.edit().putStringSet("trees",previous-value).apply()
        runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(value),android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        if (permitted()) scan() else emit(false)
    }
    private fun catalog() = (context.applicationContext as RhineApplication).catalog

    fun permission() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    private fun empty() = JSONObject().put("version", 1).put("albums", JSONArray()).put("genres", JSONArray())
        .put("roots", JSONArray()).put("scan", JSONObject().put("running", false)).put("onlineEnabled", false)

    @Synchronized fun library(): JSONObject {
        if (!permitted()) return empty().put("permission", false)
        if (snapshot == null) {
            snapshot = try {
                val saved = JSONObject(cache.openRead().bufferedReader().use { it.readText() })
                require(saved.getInt("version") == 1)
                index(saved)
                saved
            } catch (_: Exception) { tracks = emptyMap(); albums = emptyMap(); coverVersions = emptyMap(); empty() }
        }
        val copy = JSONObject(snapshot.toString()).put("permission",true)
        val items=copy.getJSONArray("albums")
        copy.put("albums",JSONArray((0 until items.length()).map { items.getJSONObject(it) }.filter(access())))
        return catalog().overlay(copy)
    }

    private fun index(value: JSONObject) {
        val result = HashMap<String, JSONObject>()
        val versions = HashMap<Long, Long>()
        val albums = value.getJSONArray("albums")
        for (a in 0 until albums.length()) {
            val album = albums.getJSONObject(a)
            album.getString("id").removePrefix("device-album-").toLongOrNull()?.let { versions[it] = album.optLong("modified") }
            val songs = album.getJSONArray("tracks")
            for (t in 0 until songs.length()) {
                val song = songs.getJSONObject(t)
                result[song.getString("id")] = song
            }
        }
        this.albums = (0 until albums.length()).associate { albums.getJSONObject(it).let { album -> album.getString("id") to album } }
        tracks = result
        coverVersions = versions
    }

    fun playableTrackIds(): Set<String> {
        val allowed=albumIds()
        return tracks.values.filter { it.optString("albumId") in allowed }.map { it.getString("id") }.toSet()
    }
    fun mediaItems(ids: List<String>): List<MediaItem> {
        val allowed=albumIds()
        return ids.mapNotNull { tracks[it]?.takeIf { track -> track.optString("albumId") in allowed }?.let(::mediaItem) }
    }
    private fun mediaItem(track: JSONObject): MediaItem {
        return MediaItem.Builder().setMediaId(track.getString("id")).setUri(track.getString("audioUrl"))
            .setMediaMetadata(MediaMetadata.Builder().setTitle(track.getString("title"))
                .setArtist(track.getString("artist")).setAlbumTitle(track.optString("albumTitle"))
                .setArtworkUri(track.optString("artworkUri").takeIf { it.isNotBlank() }?.let(Uri::parse)).build()).build()
    }

    fun coverVersion(id: String): Long = coverVersions[id.removePrefix("device-album-").toLongOrNull()] ?: 0L

    fun albumIds(): Set<String> = albums.values.filter(access()).map { it.getString("id") }.toSet()

    fun album(id: String): JSONObject? = albums[id]?.takeIf(::allowed)

    fun track(id: String): JSONObject? = tracks[id]?.takeIf { album(it.getString("albumId")) != null }

    @Synchronized fun scan() {
        if (!permitted()) { emit(false, error = "请授权读取音乐，才能扫描设备曲库。"); return }
        if (scanning) { rescanRequested = true; return }
        scanning = true
        RhineLog.event("library-scan-start")
        val signal = CancellationSignal()
        cancellation = signal
        emit(true)
        executor.execute {
            val start = SystemClock.elapsedRealtime()
            try {
                library()
                val result = if (mediaPermitted()) query(signal) { count -> emit(true,count) } else empty()
                val items=result.getJSONArray("albums")
                val roots=result.getJSONArray("roots")
                val cached=tracks.values.associateBy { it.optString("audioUrl") }.toMutableMap()
                tracks.values.forEach { if(it.has("documentKey")) cached[it.getString("documentKey")]=it }
                val mediaIds=(0 until items.length()).flatMap { a -> val songs=items.getJSONObject(a).getJSONArray("tracks"); (0 until songs.length()).map { songs.getJSONObject(it).getString("id").removePrefix("device-track-").toLong() } }.toSet()
                val added=(0 until items.length()).map { items.getJSONObject(it).getString("id") }.toMutableSet()
                var count=tracksCount(result)
                for (tree in trees()) {
                    signal.throwIfCanceled()
                    try {
                        val imported=DocumentLibrary(context).scan(tree,cached,mediaIds,signal) { count++; if(count%25==0) emit(true,count) }
                        imported.forEach { album -> if(added.add(album.getString("id"))) items.put(album) }
                        roots.put(JSONObject().put("path",tree.toString()).put("label",android.provider.DocumentsContract.getTreeDocumentId(tree).substringAfter(':')).put("status","online"))
                    } catch (error: android.os.OperationCanceledException) { throw error }
                    catch (error: Exception) {
                        albums.values.filter { it.optString("treeUri")==tree.toString() }.forEach { items.put(JSONObject(it.toString()).put("offline",true)) }
                        roots.put(JSONObject().put("path",tree.toString()).put("label",android.provider.DocumentsContract.getTreeDocumentId(tree).substringAfter(':')).put("status","offline").put("error","文件夹暂时无法读取，保留原索引"))
                        RhineLog.error("document-scan",error)
                    }
                }
                rebuildGenres(result)
                result.getJSONObject("scan").put("finishedAt", java.time.Instant.now().toString())
                    .put("elapsedMs", SystemClock.elapsedRealtime() - start).put("count", tracksCount(result))
                signal.throwIfCanceled()
                val raw = result.toString().toByteArray(Charsets.UTF_8)
                var stream: java.io.FileOutputStream? = null
                try {
                    stream = cache.startWrite(); stream.write(raw); signal.throwIfCanceled(); cache.finishWrite(stream)
                } catch (error: Exception) { cache.failWrite(stream); throw error }
                synchronized(this) { index(result); snapshot = result }
                emit(false, tracks.size)
                RhineLog.event("library-scan-finished", JSONObject().put("tracks", tracks.size)
                    .put("milliseconds", SystemClock.elapsedRealtime() - start))
                catalog().afterScan()
            } catch (_: android.os.OperationCanceledException) {
                emit(false, error = "扫描已取消，保留上次曲库。")
            } catch (_: SecurityException) {
                emit(false, error = "音乐读取权限已撤销，请重新授权。")
            } catch (error: Exception) {
                RhineLog.error("library-scan", error)
                emit(false, error = "扫描失败，保留上次曲库：${error.localizedMessage ?: "存储不可用"}")
            } finally {
                cancellation = null
                synchronized(this) { scanning = false }
                if (rescanRequested) { rescanRequested = false; scan() }
            }
        }
    }
    fun cancel() { rescanRequested = false; cancellation?.cancel() }
    private fun tracksCount(value: JSONObject): Int {
        val albums = value.getJSONArray("albums")
        return (0 until albums.length()).sumOf { albums.getJSONObject(it).getJSONArray("tracks").length() }
    }
    private fun emit(running: Boolean, count: Int = 0, error: String? = null) {
        onChanged?.invoke(JSONObject().put("type", "library-status").put("running", running).put("count", count)
            .put("error", error ?: JSONObject.NULL))
    }

    private fun query(signal: CancellationSignal, progress: (Int) -> Unit): JSONObject {
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val base = arrayOf("_id","title","artist","album","album_id","duration","track","year","_display_name","date_modified","composer","album_artist")
        var projection = if(Build.VERSION.SDK_INT>=30) base+arrayOf("genre","bitrate") else base
        val index = MusicIndex()
        val cursor = try { context.contentResolver.query(collection,projection,"duration > 0",null,null,signal) }
            catch(error: Exception) { if(error is SecurityException || error is android.os.OperationCanceledException) throw error; projection=base; context.contentResolver.query(collection,projection,"duration > 0",null,null,signal) }
            ?: error("系统媒体索引不可用")
        cursor.use {
            val columns = projection.map(cursor::getColumnIndexOrThrow)
            while (cursor.moveToNext()) {
                signal.throwIfCanceled()
                val filename = cursor.getString(columns[8]).clean("AUDIO")
                index.add(IndexedSong(cursor.getLong(columns[0]), cursor.getLong(columns[4]),
                    cursor.getString(columns[1]).clean(filename), cursor.getString(columns[2]).clean("未知艺术家"),
                    cursor.getString(columns[3]).clean("未知专辑"), cursor.getLong(columns[5]), cursor.getInt(columns[6]),
                    cursor.getInt(columns[7]), filename, cursor.getLong(columns[9]),
                    if(columns.size>12) cursor.getString(columns[12]).orEmpty() else "",cursor.getString(columns[10]).orEmpty(),
                    cursor.getString(columns[11]).orEmpty(),if(columns.size>13) cursor.getLong(columns[13]) else 0))
                if (index.count % 500 == 0) progress(index.count)
            }
        }
        val albums = linkedMapOf<Long, JSONObject>()
        for (songs in index.albums()) {
            signal.throwIfCanceled()
            val first = songs.first()
            val modified = songs.maxOf { it.modified }
            val albumId = "device-album-${first.albumId}"
            val artwork = "content://media/external/audio/albumart/${first.albumId}"
            val album = JSONObject().put("id", albumId).put("title", first.album)
                .put("artist",first.albumArtist.ifBlank { if(songs.map { it.artist }.distinct().size>1) "群星" else first.artist })
                .put("year",first.year).put("genreId",first.genre.ifBlank { "device" }).put("rawGenres",JSONArray(songs.map { it.genre }.filter { it.isNotBlank() }.distinct())).put("modified",modified)
                .put("folder", "设备音乐").put("offline", false).put("coverUrl", "/native/cover/${first.albumId}?v=$modified")
                .put("producers", JSONArray())
            val tracks = JSONArray()
            for (song in songs) tracks.put(JSONObject().put("id", "device-track-${song.id}").put("albumId", albumId)
                .put("title", song.title).put("artist", song.artist).put("albumTitle", first.album).put("artworkUri", artwork)
                .put("duration", song.durationMs / 1000.0).put("trackNumber", song.track).put("discNumber", song.disc)
                .put("format", song.filename.substringAfterLast('.', "AUDIO").uppercase()).put("browserPlayable", true)
                .put("audioUrl", ContentUris.withAppendedId(collection,song.id).toString()).put("relativePath",song.filename).put("bitrate",song.bitrate))
            songs.filter { it.composer.isNotBlank() }.forEach { album.getJSONArray("producers").put(JSONObject().put("name",it.composer).put("role","作曲").put("source","local").put("trackId","device-track-${it.id}").put("trackTitle",it.title)) }
            albums[first.albumId] = album.put("tracks", tracks)
        }
        return empty().put("albums", JSONArray(albums.values.toList())).put("genres", JSONArray().put(
            JSONObject().put("id", "device").put("name", "设备音乐").put("albumCount", albums.size)))
            .put("roots", JSONArray().put(JSONObject().put("path", "系统媒体库").put("status", "online")))
    }

    internal fun rebuildGenres(value: JSONObject) {
        val items=value.getJSONArray("albums")
        val counts=(0 until items.length()).map { items.getJSONObject(it).optString("genreId","device") }.groupingBy { it }.eachCount()
        value.put("genres",JSONArray(counts.map { (id,count) -> JSONObject().put("id",id).put("name",if(id=="device")"设备音乐" else id).put("albumCount",count) }))
    }

    /** Lazy, sampled artwork: at most 512 px, with a bounded disk cache. */
    fun cover(albumId: Long): ByteArray? {
        val album=album("device-album-$albumId") ?: return null
        if (albumId !in coverVersions) return null
        val directory = File(context.cacheDir, "covers").apply { mkdirs() }
        val file = File(directory, "${albumId}_${coverVersions[albumId] ?: 0}.jpg")
        runCatching { if (file.isFile) file.readBytes() else null }.getOrNull()?.let { return it }
        return try {
            val embedded = if(album.has("treeUri")) {
                val metadata=android.media.MediaMetadataRetriever()
                try { metadata.setDataSource(context,Uri.parse(album.getJSONArray("tracks").getJSONObject(0).getString("audioUrl"))); metadata.embeddedPicture?.takeIf { it.size<=16*1024*1024 } }
                catch (_: Exception) { null } finally { runCatching { metadata.release() } }
            } else null
            val uri=Uri.parse(if(album.has("treeUri")) album.optString("coverDocument") else "content://media/external/audio/albumart/$albumId")
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            if(embedded!=null) BitmapFactory.decodeByteArray(embedded,0,embedded.size,options)
            else context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,options) }
            var sample = 1
            while (maxOf(options.outWidth, options.outHeight) / sample > 1024) sample *= 2
            options.inJustDecodeBounds = false; options.inSampleSize = sample
            val bitmap=if(embedded!=null) BitmapFactory.decodeByteArray(embedded,0,embedded.size,options) else context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,options) }
            if(bitmap==null) return null
            val scale = 512.0 / maxOf(bitmap.width, bitmap.height).coerceAtLeast(512)
            val small = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true)
            val bytes = ByteArrayOutputStream().use { out -> small.compress(Bitmap.CompressFormat.JPEG, 85, out); out.toByteArray() }
            if (small !== bitmap) small.recycle()
            bitmap.recycle()
            synchronized(directoryLock) {
                val atomic = AtomicFile(file)
                var stream: java.io.FileOutputStream? = null
                try { stream = atomic.startWrite(); stream.write(bytes); atomic.finishWrite(stream) }
                catch (error: Exception) { atomic.failWrite(stream); throw error }
                artworkWrites++
                if (artworkWrites % 32 == 0) {
                    val files = directory.listFiles()?.sortedBy { it.lastModified() }.orEmpty()
                    var size = files.sumOf { it.length() }
                    for (old in files) { if (size <= 64L * 1024 * 1024) break; size -= old.length(); old.delete() }
                }
            }
            bytes
        } catch (_: Exception) { null }
    }
    private fun String?.clean(fallback: String) = this?.takeUnless { it.isBlank() || it == "<unknown>" } ?: fallback
    companion object {
        private val directoryLock = Any()
        fun get(context: Context): LibraryRepository = (context.applicationContext as RhineApplication).library
    }
}

class RhineApplication : android.app.Application() {
    val library by lazy { LibraryRepository(this) }
    internal val catalog by lazy { MetadataCatalog(this) }
    override fun onCreate() { super.onCreate(); RhineLog.init(this) }
}
