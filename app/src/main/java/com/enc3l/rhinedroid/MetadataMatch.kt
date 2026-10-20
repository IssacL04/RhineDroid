package com.enc3l.rhinedroid

import java.text.Normalizer
import java.util.Locale

internal object MetadataMatch {
    fun normalized(value: String) = Normalizer.normalize(value,Normalizer.Form.NFKC).lowercase(Locale.ROOT)
        .replace(Regex("[\\s\\p{P}\\p{S}]"),"")
    fun knownArtist(artist: String) = artist.isNotBlank() && !Regex("未知|unknown|various artists|群星",RegexOption.IGNORE_CASE).containsMatchIn(artist)
    fun aliases(value: String): Set<String> = (listOf(value,value.replace(Regex("[（(][^（）()]+[）)]"),"")) +
        Regex("[（(]([^（）()]+)[）)]").findAll(value).map { it.groupValues[1] }.toList())
        .map(::normalized).filter { it.isNotEmpty() }.toSet()
    private fun editions(value: String) = listOf("live|现场|現場|演唱会|演唱會","remix|混音版|重混","instrumental|karaoke|伴奏|纯音乐|純音樂",
        "acoustic|unplugged|不插电|不插電","demo|小样|小樣","remaster|重制|重製|重置版","re[ -]?record|重新录制|重新錄製",
        "radio edit|single edit|剪辑版|剪輯版","cover|翻唱").mapIndexedNotNull { i, pattern -> if(Regex(pattern,RegexOption.IGNORE_CASE).containsMatchIn(value)) i else null }.toSet()
    data class Track(val id: String, val title: String, val artist: String, val album: String, val seconds: Double)
    fun track(local: Track, candidates: List<Track>): Track? {
        if(!knownArtist(local.artist) || local.title.isBlank() || (local.album.isBlank() && local.seconds<=0)) return null
        val found=candidates.filter { candidate ->
            candidate.id.matches(Regex("[A-Za-z0-9]{5,32}")) && normalized(local.title)==normalized(candidate.title) &&
                aliases(local.artist).intersect(aliases(candidate.artist)).isNotEmpty() &&
                (local.album.isBlank() || normalized(local.album)==normalized(candidate.album)) &&
                (local.seconds<=0 || candidate.seconds>0 && kotlin.math.abs(candidate.seconds-local.seconds)<=3) &&
                editions(local.title+local.album)==editions(candidate.title+candidate.album)
        }.distinctBy { it.id }
        return found.singleOrNull()
    }
    fun album(title: String, artist: String, candidateTitle: String, candidateArtists: List<String>) =
        knownArtist(artist) && editions(title)==editions(candidateTitle) && aliases(title).intersect(aliases(candidateTitle)).isNotEmpty() &&
            candidateArtists.any { aliases(it).intersect(aliases(artist)).isNotEmpty() }
}

internal object MetadataResponse {
    fun read(input: java.io.InputStream, limit: Int): ByteArray {
        val output=java.io.ByteArrayOutputStream()
        val buffer=ByteArray(8192)
        while(true) {
            val count=input.read(buffer)
            if(count<0) break
            require(output.size()+count<=limit) { "资料响应过大" }
            output.write(buffer,0,count)
        }
        return output.toByteArray()
    }
}
