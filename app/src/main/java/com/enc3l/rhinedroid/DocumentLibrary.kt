package com.enc3l.rhinedroid

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.CancellationSignal
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.nio.ByteBuffer

internal object DocumentIdentity {
    fun id(value: String): Long = (ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(value.toByteArray())).long
        and 0x3fffffffffffffffL) or 0x4000000000000000L
    fun audio(name: String, mime: String) = mime.startsWith("audio/") || name.substringAfterLast('.').lowercase() in
        setOf("mp3","flac","m4a","mp4","aac","ogg","opus","wav","aif","aiff","alac","ape","wv","wma","dsf","dff")
}

/** One cursor per directory. Unchanged files reuse the previous index, including their tags. */
internal class DocumentLibrary(private val context: Context) {
    fun scan(tree: Uri, cached: Map<String, JSONObject>, mediaIds: Set<Long>, signal: CancellationSignal, progress: () -> Unit): List<JSONObject> {
        val resolver = context.contentResolver
        val pending = ArrayDeque<String>().apply { add(DocumentsContract.getTreeDocumentId(tree)) }
        val visited = hashSetOf<String>()
        val albums = linkedMapOf<String, JSONObject>()
        while (pending.isNotEmpty()) {
            signal.throwIfCanceled()
            val parent = pending.removeFirst()
            if (!visited.add(parent)) continue
            check(visited.size <= 100000) { "文件夹层级数量过多，请选择更具体的音乐文件夹" }
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree,parent)
            val rows = mutableListOf<Array<Any>>()
            resolver.query(children,arrayOf("document_id","_display_name","mime_type","last_modified"),null,null,null,signal)
                ?.use { cursor -> while(cursor.moveToNext()) {
                    signal.throwIfCanceled()
                    rows.add(arrayOf(cursor.getString(0),cursor.getString(1)?:"AUDIO",cursor.getString(2)?:"",cursor.getLong(3)))
                } }
                ?: error("文件夹暂时无法读取")
            val coverRow = rows.firstOrNull { row -> (row[1] as String).lowercase().matches(Regex("(?:cover|folder|front)\\.(?:jpg|jpeg|png|webp)")) }
            val cover=coverRow?.let { DocumentsContract.buildDocumentUriUsingTree(tree,it[0] as String).toString() }
            for (row in rows) {
                signal.throwIfCanceled()
                val document = row[0] as String; val name = row[1] as String; val mime = row[2] as String; val modified = row[3] as Long
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) { pending.add(document); continue }
                if (!DocumentIdentity.audio(name,mime)) continue
                val uri = DocumentsContract.buildDocumentUriUsingTree(tree,document)
                if(mediaIds.isNotEmpty() && android.os.Build.VERSION.SDK_INT>=29) {
                    val mapped=runCatching { android.provider.MediaStore.getMediaUri(context,uri) }.getOrNull()
                    if(mapped!=null && mapped.pathSegments.contains("audio") && mapped.lastPathSegment?.toLongOrNull() in mediaIds) continue
                }
                val documentKey="document:${uri.authority}|$document"
                val prior = cached[uri.toString()] ?: cached[documentKey]
                val song = if (modified > 0 && prior?.optLong("modified") == modified) JSONObject(prior.toString()) else tags(uri,name)
                val albumTitle = song.optString("albumTitle").ifBlank { parent.substringAfterLast('/').substringAfterLast(':').ifBlank { "音乐文件夹" } }
                val albumArtist = song.optString("albumArtist")
                val number = DocumentIdentity.id("${tree.authority}|$parent|$albumTitle|$albumArtist")
                val id = "device-album-$number"
                song.put("documentKey",documentKey).put("albumId",id).put("modified",modified).put("audioUrl",uri.toString()).put("albumTitle",albumTitle)
                    .put("id","device-track-${DocumentIdentity.id(documentKey)}").put("relativePath",name).put("browserPlayable",true)
                    .put("format",name.substringAfterLast('.',"AUDIO").uppercase())
                val album = albums.getOrPut(id) { JSONObject().put("id",id).put("title",albumTitle).put("artist",albumArtist.ifBlank { song.optString("artist","未知艺术家") })
                    .put("year",song.optInt("year")).put("genreId",song.optString("genre").ifBlank { "device" })
                    .put("rawGenres",JSONArray().also { if(song.optString("genre").isNotBlank()) it.put(song.getString("genre")) })
                    .put("folder",parent.substringAfterLast(':')).put("treeUri",tree.toString()).put("offline",false)
                    .put("modified",coverRow?.get(3) ?: 0L).put("coverUrl","/native/cover/$number?v=$modified").put("coverDocument",cover)
                    .put("producers",JSONArray()).put("tracks",JSONArray()) }
                if(albumArtist.isBlank() && album.optString("artist")!=song.optString("artist")) album.put("artist","群星")
                album.getJSONArray("tracks").put(song)
                album.put("modified",maxOf(album.optLong("modified"),modified))
                val composer = song.optString("composer")
                if (composer.isNotBlank()) album.getJSONArray("producers").put(JSONObject().put("name",composer).put("role","作曲")
                    .put("source","local").put("trackId",song.getString("id")).put("trackTitle",song.getString("title")))
                progress()
            }
        }
        albums.values.forEach { album ->
            val tracks = album.getJSONArray("tracks")
            val sorted = (0 until tracks.length()).map { tracks.getJSONObject(it) }.sortedWith(
                compareBy<JSONObject> { it.optInt("discNumber",1) }.thenBy { it.optInt("trackNumber") }.thenBy { it.optString("title") })
            album.put("tracks",JSONArray(sorted)).put("coverUrl","/native/cover/${album.getString("id").removePrefix("device-album-")}?v=${album.optLong("modified")}")
        }
        return albums.values.toList()
    }
    private fun tags(uri: Uri, name: String): JSONObject {
        val result = JSONObject().put("title",name.substringBeforeLast('.')).put("artist","未知艺术家").put("duration",0)
        val metadata = MediaMetadataRetriever()
        try {
            metadata.setDataSource(context,uri)
            fun text(key: Int) = metadata.extractMetadata(key)?.trim()?.takeUnless { it.isBlank() || it=="<unknown>" }
            listOf("title" to 7,"artist" to 2,"albumTitle" to 1,"albumArtist" to 13,"composer" to 4,"genre" to 6).forEach { (field,key) ->
                text(key)?.let { result.put(field,it) }
            }
            result.put("tagAlbum",text(1))
            result.put("duration",(text(9)?.toLongOrNull()?:0)/1000.0).put("year",text(8)?.take(4)?.toIntOrNull()?:0)
                .put("trackNumber",text(0)?.substringBefore('/')?.toIntOrNull()?:0).put("discNumber",text(14)?.substringBefore('/')?.toIntOrNull()?:1)
                .put("bitrate",text(20)?.toLongOrNull()?:0)
        } catch (error: Exception) { RhineLog.event("document-tag-unavailable",JSONObject().put("error",error.javaClass.simpleName)) }
        finally { runCatching { metadata.release() } }
        return result
    }
}
