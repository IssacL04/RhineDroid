package com.enc3l.rhinedroid

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/** Opt-in public metadata. Original audio and tags remain read-only. */
internal class MetadataCatalog(private val context: Context) {
    private val library get() = LibraryRepository.get(context)
    private val prefs = context.getSharedPreferences("metadata",Context.MODE_PRIVATE)
    private val store = AtomicFile(File(context.filesDir,"album-metadata.json"))
    private var records=JSONObject()
    private var loaded=false
    @Synchronized private fun loadCache() {
        if(loaded) return
        records=runCatching { JSONObject(store.openRead().bufferedReader().use { it.readText() }) }
            .getOrElse { if(store.baseFile.exists()) RhineLog.error("metadata-cache",it); JSONObject() }
        loaded=true
    }
    private val jobs = Executors.newSingleThreadExecutor()
    private val requests = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var running: String? = null
    @Volatile private var status = JSONObject()
    @Volatile private var canceled = false
    @Volatile private var connection: HttpsURLConnection? = null
    private val lastRequests = mutableMapOf<MetadataSource, Long>()
    private val jobLock=Any()
    var onChanged: (() -> Unit)? = null
    private fun identity(album: JSONObject)=JSONArray().put(album.optString("title")).put(album.optString("artist")).put(album.optLong("modified")).toString()
    @Synchronized fun overlay(value: JSONObject): JSONObject {
        loadCache()
        val albums=value.getJSONArray("albums")
        for(i in 0 until albums.length()) {
            val album=albums.getJSONObject(i)
            val record=records.optJSONObject(album.getString("id")) ?: continue
            record.keys().forEach { key ->
                if(key!="genreOverride" && record.optString("identity")!=identity(album)) return@forEach
                if(key=="producers") {
                    val people=album.optJSONArray("producers") ?: JSONArray()
                    val extra=record.getJSONArray(key)
                    val seen=hashSetOf<String>()
                    val combined=JSONArray()
                    (0 until people.length()).map { people.getJSONObject(it) }.plus((0 until extra.length()).map { extra.getJSONObject(it) }).forEach { person ->
                        val id=listOf("name","role","source","trackId").joinToString("|") { person.optString(it) }
                        if(seen.add(id)) combined.put(person)
                    }
                    album.put(key,combined)
                } else if(key !in listOf("queriedAt","genreOverride","identity")) album.put(key,record.get(key))
            }
            if(record.optString("genreOverride").isNotBlank()) album.put("genreId",record.getString("genreOverride"))
        }
        library.rebuildGenres(value)
        value.put("onlineEnabled",prefs.getBoolean("onlineEnabled",false))
        for(key in listOf("introductions","credits","enrich")) value.put(key,if(status.optString("kind")==key) JSONObject(status.toString()) else JSONObject().put("running",false))
        return value
    }
    @Synchronized private fun commit(id: String, patch: JSONObject) {
        loadCache()
        val next=JSONObject(records.toString())
        val previous=next.optJSONObject(id) ?: JSONObject()
        val record=if(patch.has("identity") && patch.optString("identity")!=previous.optString("identity"))
            JSONObject().put("genreOverride",previous.opt("genreOverride")) else previous
        patch.keys().forEach { key -> record.put(key,patch.get(key)) }
        next.put(id,record)
        var stream: java.io.FileOutputStream?=null
        try { stream=store.startWrite(); stream.write(next.toString().toByteArray()); store.finishWrite(stream); records=next }
        catch(error: Exception) { store.failWrite(stream); throw error }
    }
    fun afterScan() { if(prefs.getBoolean("onlineEnabled",false) && prefs.getString("contact","").orEmpty().isNotBlank()) runCatching { start("enrich",null,false) } }
    fun cancel() { canceled=true; connection?.disconnect() }
    fun api(message: JSONObject, reply: (Result<Any>) -> Unit) {
        requests.execute {
            val result=runCatching<Any> {
                val route=message.getString("route"); val body=message.optJSONObject("body")
                when(route) {
                    "/api/config" -> {
                        if(body!=null) {
                            val contact=body.optString("musicBrainzContact").trim()
                            require(contact.length in 3..240 && contact.none { it.isISOControl() } && (contact.contains('@') || contact.startsWith("https://"))) { "请填写有效联系邮箱或 HTTPS 项目网址" }
                            prefs.edit().putString("contact",contact).putBoolean("onlineEnabled",body.optBoolean("onlineEnabled")).apply()
                        }
                        JSONObject().put("musicBrainzContact",prefs.getString("contact",""))
                            .put("musicBrainzConfigured",prefs.getString("contact","").orEmpty().isNotBlank()).put("onlineEnabled",prefs.getBoolean("onlineEnabled",false))
                    }
                    "/api/library/introductions", "/api/library/credits", "/api/library/enrich" -> {
                        start(route.substringAfterLast('/'),body?.optJSONArray("albumIds"),body?.optBoolean("force")?:false)
                        JSONObject().put("ok",true)
                    }
                    "/api/library/cancel-metadata" -> { cancel(); JSONObject().put("ok",true) }
                    "/api/album/genre" -> {
                        val id=checkNotNull(body).getString("albumId"); require(library.album(id)!=null)
                        val genre=body.getString("genre").trim(); require(genre.length in 1..80 && genre.none { it.isISOControl() })
                        commit(id,JSONObject().put("genreOverride",genre)); JSONObject().put("ok",true)
                    }
                    else -> error("不支持的资料操作")
                }
            }
            main.post { reply(result) }
        }
    }
    private fun start(kind: String, ids: JSONArray?, force: Boolean) {
        if(kind=="enrich") require(prefs.getString("contact","").orEmpty().isNotBlank()) { "请先在 MusicBrainz 设置中填写联系信息" }
        val albums=library.library().getJSONArray("albums")
        val wanted=ids?.let { input -> (0 until input.length()).map { input.getString(it) }.toSet() }
        val list=(0 until albums.length()).map { albums.getJSONObject(it) }.filter { wanted==null || it.getString("id") in wanted }
        require(list.isNotEmpty()) { "没有可查询的专辑" }
        if(wanted!=null) { val available=list.map { it.getString("id") }.toSet(); require(wanted.all { it in available }) }
        synchronized(jobLock) { check(running==null) { "已有资料查询正在运行，请等待完成或取消" }; canceled=false; running=kind }
        status=JSONObject().put("kind",kind).put("running",true).put("completed",0).put("total",list.size).put("updated",0).put("notFound",0).put("failed",0)
        jobs.execute {
            var completed=0; var updated=0; var missing=0; var failed=0
            try {
                for(album in list) {
                    if(canceled) break
                    val id=album.getString("id")
                    if(library.album(id)==null) { canceled=true; break }
                    val existing=synchronized(this) { records.optJSONObject(id)?.takeIf { it.optString("identity")==identity(album) }?.optJSONObject("queriedAt")?.optLong(kind)?:0 }
                    if(!force && System.currentTimeMillis()-existing<7*86400000L) { completed++; continue }
                    status=JSONObject(status.toString()).put("currentAlbum",album.optString("title"))
                    var pause=false
                    val patch=try { when(kind) { "credits" -> credits(album); "introductions" -> introduction(album); else -> enrich(album) } }
                    catch(error: Exception) {
                        if(canceled) break
                        RhineLog.error("metadata-$kind",error)
                        failed++
                        pause=error is MetadataRequestException && (error.retryable || error.httpStatus==403)
                        if(pause) status=JSONObject(status.toString()).put("error","${error.message}。查询已暂停，再次查询将复用已完成专辑的缓存。")
                        val key=when(kind) { "credits" -> "creditsLookup"; "introductions" -> "introduction"; else -> "online" }
                        JSONObject().put(key,JSONObject().put("status","error").put("error",error.message?.take(240)).put("checkedAt",stamp())
                            .put("source",(error as? MetadataRequestException)?.source?.label ?: when(kind) { "credits" -> "QQ Music"; "introductions" -> "维基百科 / Wikidata"; else -> "MusicBrainz" }))
                    }
                    if(canceled) break
                    val query=synchronized(this) { JSONObject(records.optJSONObject(id)?.takeIf { it.optString("identity")==identity(album) }?.optJSONObject("queriedAt")?.toString()?:"{}") }.put(kind,System.currentTimeMillis())
                    val itemStatus=patch.optJSONObject(when(kind) { "credits" -> "creditsLookup"; "introductions" -> "introduction"; else -> "online" })?.optString("status")
                    if(itemStatus!="error") patch.put("queriedAt",query)
                    patch.put("identity",identity(album))
                    commit(id,patch)
                    if(itemStatus in listOf("matched","partial")) updated++ else if(itemStatus!="error") missing++
                    completed++
                    status=JSONObject(status.toString()).put("completed",completed).put("updated",updated).put("notFound",missing).put("failed",failed)
                    main.post { onChanged?.invoke() }
                    if(pause) break
                }
            } catch(error: Exception) { status=JSONObject(status.toString()).put("error",error.message); RhineLog.error("metadata-job",error) }
            finally {
                status=JSONObject(status.toString()).put("running",false).put("completed",completed)
                    .put("error",if(canceled)"查询已取消，已取得的资料保留" else status.opt("error"))
                running=null; main.post { onChanged?.invoke() }
            }
        }
    }
    private fun stamp()=java.time.Instant.now().toString()
    private fun encode(value: String)=URLEncoder.encode(value,"UTF-8")
    private fun awaitSource(source: MetadataSource) {
        val interval=MetadataRequestPolicy.interval(source,prefs.getString("contact","").orEmpty().isNotBlank())
        while(true) {
            check(!canceled) { "查询已取消" }
            val now=System.currentTimeMillis()
            // Honor any outstanding cooldown saved by an older app version too.
            val retryAt=maxOf(prefs.getLong(source.retryKey,0),prefs.getLong("retryAt",0))
            val wait=maxOf(retryAt-now,lastRequests[source]?.let { it+interval-SystemClock.elapsedRealtime() }?:0)
            if(wait<=0) break
            if(retryAt>now && status.optLong("retryAt")!=retryAt) {
                status=JSONObject(status.toString()).put("retryAt",retryAt).put("waitingSource",source.label)
                main.post { onChanged?.invoke() }
            }
            Thread.sleep(minOf(wait,250))
        }
        if(status.has("retryAt")) {
            status=JSONObject(status.toString()).also { it.remove("retryAt"); it.remove("waitingSource") }
            main.post { onChanged?.invoke() }
        }
        lastRequests[source]=SystemClock.elapsedRealtime()
    }
    private fun get(url: String, payload: JSONObject?=null): JSONObject {
        val target=URI(url)
        require(target.scheme=="https")
        val source=MetadataSource.fromHost(target.host)
        return MetadataRequestPolicy.execute({ awaitSource(source) }) { attempt ->
            check(!canceled) { "查询已取消" }
            val request=URL(url).openConnection() as HttpsURLConnection
            connection=request
            try {
                request.connectTimeout=8000; request.readTimeout=8000; request.instanceFollowRedirects=false
                val contact=prefs.getString("contact","").orEmpty().ifBlank { "Android local music metadata lookup" }
                request.setRequestProperty("User-Agent","RhineDroid/${BuildConfig.VERSION_NAME} ($contact)")
                request.setRequestProperty("Accept","application/json")
                if(payload!=null) { request.requestMethod="POST"; request.doOutput=true; request.setRequestProperty("Content-Type","application/json"); request.setRequestProperty("Referer","https://y.qq.com/"); request.outputStream.use { it.write(payload.toString().toByteArray()) } }
                val code=request.responseCode
                val result=if(code==200) JSONObject(request.inputStream.use { MetadataResponse.read(it,2*1024*1024) }.toString(Charsets.UTF_8)) else null
                val apiCode=result?.optJSONObject("error")?.optString("code")
                if(code!=200 || apiCode!=null) {
                    val retryable=MetadataRequestException(source,target.host,code,apiCode=apiCode).retryable
                    val retryAt=if(retryable || code==403) MetadataRequestPolicy.retryAt(request.getHeaderField("Retry-After"),System.currentTimeMillis(),attempt) else null
                    if(retryAt!=null) prefs.edit().putLong(source.retryKey,retryAt).apply()
                    RhineLog.event("metadata-http-error",JSONObject().put("source",source.label).put("host",target.host).put("path",target.path)
                        .put("httpStatus",code).put("apiCode",apiCode).put("attempt",attempt+1).put("retryAt",retryAt))
                    throw MetadataRequestException(source,target.host,code,retryAt,apiCode)
                }
                checkNotNull(result)
            } finally { connection=null; request.disconnect() }
        }
    }
    private fun mb(path: String, params: String): JSONObject {
        require(prefs.getString("contact","").orEmpty().isNotBlank()) { "请先填写 MusicBrainz 联系信息" }
        return get("https://musicbrainz.org/ws/2/$path?fmt=json&$params")
    }
    private fun enrich(album: JSONObject): JSONObject {
        val title=album.getString("title"); val artist=album.getString("artist")
        fun quoted(value: String)=value.replace("\\","\\\\").replace("\"","\\\"")
        val result=mb("release","limit=8&query="+encode("release:\"${quoted(title)}\" AND artist:\"${quoted(artist)}\""))
        val candidates=result.optJSONArray("releases") ?: JSONArray()
        val matches=(0 until candidates.length()).map { candidates.getJSONObject(it) }.filter { release ->
            val credits=release.optJSONArray("artist-credit") ?: JSONArray()
            MetadataMatch.album(title,artist,release.optString("title"),(0 until credits.length()).map { credits.getJSONObject(it).optJSONObject("artist")?.optString("name").orEmpty() })
        }
        val groups=matches.map { it.optJSONObject("release-group")?.optString("id") }.distinct()
        if(matches.isEmpty() || groups.size!=1) return JSONObject().put("online",JSONObject().put("status",if(matches.isEmpty())"not-found" else "uncertain").put("checkedAt",stamp()))
        val id=matches.first().getString("id"); require(id.matches(Regex("[0-9a-f-]{36}")))
        val release=mb("release/$id","inc=artist-credits+recordings+recording-level-rels+artist-rels+release-groups+genres")
        val people=JSONArray()
        fun collect(relations: JSONArray?, track: JSONObject?=null) {
            if(relations==null) return
            for(i in 0 until relations.length()) {
                val relation=relations.getJSONObject(i); val person=relation.optJSONObject("artist") ?: continue
                val role=relation.optString("type")
                if(!Regex("producer|engineer|mix|master|arranger|composer",RegexOption.IGNORE_CASE).containsMatchIn(role)) continue
                people.put(JSONObject().put("name",person.optString("name")).put("role",role).put("source","MusicBrainz")
                    .put("trackId",track?.optString("id")).put("trackTitle",track?.optString("title")).put("url","https://musicbrainz.org/release/$id"))
            }
        }
        collect(release.optJSONArray("relations"))
        val media=release.optJSONArray("media") ?: JSONArray(); val local=album.getJSONArray("tracks")
        for(m in 0 until media.length()) {
            val tracks=media.getJSONObject(m).optJSONArray("tracks") ?: continue
            for(t in 0 until tracks.length()) {
                val song=tracks.getJSONObject(t)
                val known=(0 until local.length()).map { local.getJSONObject(it) }.filter { MetadataMatch.normalized(it.optString("title"))==MetadataMatch.normalized(song.optString("title")) }.singleOrNull()
                if(known!=null) collect(song.optJSONObject("recording")?.optJSONArray("relations"),known)
            }
        }
        val old=album.optJSONArray("producers") ?: JSONArray()
        for(i in 0 until old.length()) if(old.getJSONObject(i).optString("source")!="MusicBrainz") people.put(old.getJSONObject(i))
        val patch=JSONObject().put("producers",people).put("online",JSONObject().put("status","matched").put("releaseId",id).put("checkedAt",stamp()).put("sourceUrl","https://musicbrainz.org/release/$id"))
        val genres=release.optJSONArray("genres")
        if(genres!=null && genres.length()>0 && album.optString("genreId")=="device") patch.put("genreId",genres.getJSONObject(0).optString("name","device"))
        return patch
    }
    private fun qq(module: String, method: String, param: JSONObject): JSONObject {
        val key=if(module=="music.search.SearchCgiService")module else "req_0"
        val body=JSONObject().put(key,JSONObject().put("module",module).put("method",method).put("param",param))
        if(key=="req_0") body.put("comm",JSONObject().put("ct",24).put("cv",0).put("format","json").put("uin",0))
        val result=get("https://u.y.qq.com/cgi-bin/musicu.fcg",body).getJSONObject(key)
        check(result.optInt("code",-1)==0) { "QQ Music 服务暂时不可用" }
        return result.getJSONObject("data")
    }
    private fun credits(album: JSONObject): JSONObject {
        val people=JSONArray(); val tracks=album.getJSONArray("tracks"); var matched=0
        for(n in 0 until tracks.length()) {
            check(!canceled)
            val track=tracks.getJSONObject(n)
            val local=MetadataMatch.Track("local",track.getString("title"),track.getString("artist"),
                if(album.has("treeUri"))track.optString("tagAlbum") else track.optString("albumTitle"),track.optDouble("duration",0.0))
            if(!MetadataMatch.knownArtist(local.artist)) continue
            val data=qq("music.search.SearchCgiService","DoSearchForQQMusicDesktop",JSONObject().put("search_type",0).put("query","${local.title} ${local.artist}").put("page_num",1).put("num_per_page",20))
            val songs=data.getJSONObject("body").getJSONObject("song").getJSONArray("list")
            val candidates=(0 until minOf(20,songs.length())).map { i ->
                val song=songs.getJSONObject(i); val artists=song.optJSONArray("singer") ?: JSONArray()
                MetadataMatch.Track(song.optString("mid"),song.optString("name"),
                    (0 until artists.length()).joinToString("/") { artists.getJSONObject(it).optString("name") },
                    song.optJSONObject("album")?.optString("name").orEmpty(),song.optDouble("interval",0.0))
            }
            val match=MetadataMatch.track(local,candidates) ?: continue
            val groups=qq("music.sociality.KolWorksTag","SongProducer",JSONObject().put("songmid",match.id)).getJSONArray("Lst")
            val before=people.length()
            for(g in 0 until groups.length()) {
                val group=groups.getJSONObject(g); val role=group.optString("Title").trim(); val names=group.optJSONArray("Producers") ?: continue
                for(p in 0 until names.length()) {
                    val name=names.getJSONObject(p).optString("Name").trim()
                    if(name.isNotBlank() && role.isNotBlank()) people.put(JSONObject().put("name",name.take(240)).put("role",role.take(100)).put("source","QQ Music")
                        .put("trackId",track.getString("id")).put("trackTitle",local.title).put("url","https://y.qq.com/n/ryqq/songDetail/${match.id}"))
                }
            }
            if(people.length()>before) matched++
        }
        val status=if(matched==tracks.length())"matched" else if(matched>0)"partial" else "not-found"
        val patch=JSONObject().put("creditsLookup",JSONObject().put("status",status).put("source","QQ Music").put("checkedAt",stamp()).put("matchedTracks",matched).put("totalTracks",tracks.length()))
        if(people.length()>0) {
            val old=album.optJSONArray("producers") ?: JSONArray()
            for(i in 0 until old.length()) if(old.getJSONObject(i).optString("source")!="QQ Music") people.put(old.getJSONObject(i))
            patch.put("producers",people)
        }
        return patch
    }
    private fun introduction(album: JSONObject): JSONObject {
        var uncertain=false
        for(language in listOf("zh","en")) {
            val query=encode(album.getString("title")+" "+album.getString("artist"))
            val response=get("https://$language.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&generator=search&gsrnamespace=0&gsrlimit=5&gsrsearch=$query&prop=extracts%7Cpageprops&exintro=1&explaintext=1&exchars=1200")
            val pages=response.optJSONObject("query")?.optJSONArray("pages") ?: continue
            val candidates=(0 until pages.length()).map { pages.getJSONObject(it) }.filter { !it.optJSONObject("pageprops").let { props -> props?.has("disambiguation")?:false } }
            val ids=candidates.mapNotNull { it.optJSONObject("pageprops")?.optString("wikibase_item")?.takeIf { id -> id.matches(Regex("Q[0-9]+")) } }.distinct()
            if(ids.isEmpty()) continue
            val entities=get("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&maxlag=5&props=labels%7Caliases%7Cclaims&languages=zh%7Czh-hans%7Czh-hant%7Cen&ids="+ids.joinToString("%7C")).getJSONObject("entities")
            fun claims(entity: JSONObject?, key: String): List<Any> {
                val list=entity?.optJSONObject("claims")?.optJSONArray(key) ?: return emptyList()
                return (0 until list.length()).mapNotNull { i -> list.getJSONObject(i).takeUnless { it.optString("rank")=="deprecated" }?.optJSONObject("mainsnak")?.optJSONObject("datavalue")?.opt("value") }
            }
            val performers=ids.flatMap { id -> claims(entities.optJSONObject(id),"P175").mapNotNull { (it as? JSONObject)?.optString("id") } }.distinct().take(30)
            if(performers.isEmpty()) continue
            val artists=get("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&maxlag=5&props=labels%7Caliases&languages=zh%7Czh-hans%7Czh-hant%7Cen&ids="+performers.joinToString("%7C")).getJSONObject("entities")
            fun names(entity: JSONObject?): List<String> {
                if(entity==null) return emptyList()
                val labels=entity.optJSONObject("labels") ?: JSONObject(); val aliases=entity.optJSONObject("aliases") ?: JSONObject()
                return labels.keys().asSequence().map { labels.getJSONObject(it).optString("value") }.toList()+aliases.keys().asSequence().flatMap { key ->
                    val list=aliases.getJSONArray(key); (0 until list.length()).asSequence().map { list.getJSONObject(it).optString("value") }
                }.toList()
            }
            val matched=candidates.filter { page ->
                val entity=entities.optJSONObject(page.optJSONObject("pageprops")?.optString("wikibase_item").orEmpty())
                val titles=listOf(page.optString("title").replace(Regex("\\s*[（(][^（）()]*?(?:album|专辑|專輯|EP)[）)]$",RegexOption.IGNORE_CASE),""))+names(entity)
                val artistNames=claims(entity,"P175").flatMap { value -> names(artists.optJSONObject((value as? JSONObject)?.optString("id").orEmpty())) }
                val years=claims(entity,"P577").mapNotNull { (it as? JSONObject)?.optString("time")?.removePrefix("+")?.take(4)?.toIntOrNull() }
                titles.any { MetadataMatch.album(album.optString("title"),album.optString("artist"),it,artistNames) } &&
                    (album.optInt("year")==0 || years.isEmpty() || album.getInt("year") in years) && page.optString("extract").isNotBlank()
            }
            if(matched.size==1) {
                val page=matched.single(); val url="https://$language.wikipedia.org/wiki/"+encode(page.getString("title").replace(' ','_'))
                return JSONObject().put("description",page.getString("extract").take(4000)).put("descriptionSource",JSONObject().put("name",if(language=="zh")"维基百科" else "Wikipedia").put("url",url).put("checkedAt",stamp()).put("license","CC BY-SA，以来源页为准"))
                    .put("introduction",JSONObject().put("status","matched").put("checkedAt",stamp()))
            }
            uncertain=uncertain || candidates.isNotEmpty()
        }
        return JSONObject().put("introduction",JSONObject().put("status",if(uncertain)"uncertain" else "not-found").put("checkedAt",stamp()))
    }
}
