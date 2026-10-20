package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class MetadataRequestPolicyTest {
    @Test fun wikiHostsShareOneQuotaButOtherProvidersRemainIndependent() {
        val wiki=MetadataSource.fromHost("zh.wikipedia.org")
        assertEquals(wiki,MetadataSource.fromHost("en.wikipedia.org"))
        assertEquals(wiki,MetadataSource.fromHost("www.wikidata.org"))
        assertNotEquals(wiki.retryKey,MetadataSource.QQ.retryKey)
        assertNotEquals(wiki.retryKey,MetadataSource.MUSICBRAINZ.retryKey)
        assertEquals(6500L,MetadataRequestPolicy.interval(wiki,false))
        assertEquals(1500L,MetadataRequestPolicy.interval(wiki,true))
        assertEquals(1500L,MetadataRequestPolicy.interval(MetadataSource.MUSICBRAINZ,true))
        assertThrows(IllegalArgumentException::class.java) { MetadataSource.fromHost("example.org") }
    }

    @Test fun retryAfterAcceptsSecondsAndHttpDatesAndBacksOffWhenMissing() {
        val now=Instant.parse("2026-10-20T00:00:00Z").toEpochMilli()
        assertEquals(now+120_000,MetadataRequestPolicy.retryAt("120",now,0))
        assertEquals(now+120_000,MetadataRequestPolicy.retryAt("Tue, 20 Oct 2026 00:02:00 GMT",now,0))
        assertEquals(now+60_000,MetadataRequestPolicy.retryAt(null,now,0))
        assertEquals(now+120_000,MetadataRequestPolicy.retryAt("invalid",now,1))
        assertEquals(now+60_000,MetadataRequestPolicy.retryAt("-1",now,0))
        assertEquals(now+60_000,MetadataRequestPolicy.retryAt(Long.MAX_VALUE.toString(),now,0))
        assertEquals(now+1000,MetadataRequestPolicy.retryAt("0",now,0))
    }

    @Test fun a429AfterTwoAlbumsWaitsAndStillFinishesA432AlbumBatch() {
        var now=0L; var retryAt=0L; var calls=0
        val completed=mutableListOf<Int>()
        for(album in 0 until 432) {
            completed+=MetadataRequestPolicy.execute({ now=maxOf(now,retryAt) }) { attempt ->
                calls++
                if(album==2 && attempt==0) {
                    retryAt=MetadataRequestPolicy.retryAt("60",now,attempt)
                    throw MetadataRequestException(MetadataSource.WIKIMEDIA,"www.wikidata.org",429,retryAt)
                }
                album
            }
        }
        assertEquals(432,completed.size)
        assertEquals((0 until 432).toList(),completed)
        assertEquals(433,calls)
        assertEquals(60_000L,now)
    }

    @Test fun persistentLimitsStopAfterThreeAttemptsAndReportTheRealSource() {
        var calls=0
        val error=assertThrows(MetadataRequestException::class.java) {
            MetadataRequestPolicy.execute({}) {
                calls++
                throw MetadataRequestException(MetadataSource.QQ,"u.y.qq.com",429,60_000)
            }
        }
        assertEquals(3,calls)
        assertEquals(MetadataSource.QQ,error.source)
        assertTrue(error.message!!.contains("u.y.qq.com"))
        assertEquals(60_000L,error.retryAt)
    }

    @Test fun accessDenialsAreNotRetriedAndCancellationInterruptsACooldown() {
        var calls=0
        assertThrows(MetadataRequestException::class.java) {
            MetadataRequestPolicy.execute({}) {
                calls++
                throw MetadataRequestException(MetadataSource.QQ,"u.y.qq.com",403)
            }
        }
        assertEquals(1,calls)
        var waits=0
        assertThrows(IllegalStateException::class.java) {
            MetadataRequestPolicy.execute({ check(++waits==1) { "查询已取消" } }) {
                calls++
                throw MetadataRequestException(MetadataSource.WIKIMEDIA,"www.wikidata.org",429)
            }
        }
        assertEquals(2,calls)
        assertEquals(2,waits)
    }

    @Test fun http200ApiBackpressureIsRetriedInsteadOfBecomingNotFound() {
        var calls=0
        val result=MetadataRequestPolicy.execute({}) { attempt ->
            calls++
            if(attempt==0) throw MetadataRequestException(MetadataSource.WIKIMEDIA,"www.wikidata.org",200,apiCode="maxlag")
            "matched"
        }
        assertEquals("matched",result)
        assertEquals(2,calls)
    }
}
