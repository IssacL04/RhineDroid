package com.enc3l.rhinedroid

import java.io.IOException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

internal enum class MetadataSource(val label: String) {
    WIKIMEDIA("维基百科 / Wikidata"), MUSICBRAINZ("MusicBrainz"), QQ("QQ Music");

    val retryKey get() = "retryAt-$name"

    companion object {
        fun fromHost(host: String) = when (host) {
            "zh.wikipedia.org", "en.wikipedia.org", "www.wikidata.org" -> WIKIMEDIA
            "musicbrainz.org" -> MUSICBRAINZ
            "u.y.qq.com" -> QQ
            else -> throw IllegalArgumentException("不支持的资料来源")
        }
    }
}

internal class MetadataRequestException(
    val source: MetadataSource,
    host: String,
    val httpStatus: Int,
    val retryAt: Long? = null,
    val apiCode: String? = null,
) : IOException("${source.label}（$host）返回 ${apiCode?.let { "API $it" } ?: "HTTP $httpStatus"}，已有资料保留") {
    val retryable get() = httpStatus in listOf(429, 503) || apiCode in listOf("ratelimited", "maxlag")
}

internal object MetadataRequestPolicy {
    const val MAX_ATTEMPTS = 3

    // Wikimedia's unidentified clients share a 10-request/minute IP quota.
    fun interval(source: MetadataSource, identified: Boolean) =
        if (source == MetadataSource.WIKIMEDIA && !identified) 6500L else 1500L

    fun retryAt(header: String?, now: Long, attempt: Int): Long {
        val value = header?.trim().orEmpty()
        val seconds = value.toLongOrNull()?.takeIf { it >= 0 && it <= (Long.MAX_VALUE - now) / 1000 }
        val date = runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
        return maxOf(now + 1000, seconds?.let { now + it * 1000 } ?: date ?: (now + 60_000L * (1L shl attempt.coerceIn(0, 8))))
    }

    fun <T> execute(awaitReady: () -> Unit, request: (attempt: Int) -> T): T {
        for (attempt in 0 until MAX_ATTEMPTS) {
            awaitReady()
            try {
                return request(attempt)
            } catch (error: MetadataRequestException) {
                if (!error.retryable || attempt == MAX_ATTEMPTS - 1) throw error
            }
        }
        error("资料查询重试次数已耗尽")
    }
}
