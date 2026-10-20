package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class ArchiveAnimationTest {
    @Test fun opticsFocusOnTheCoverPlaneEvenWhenTheAlbumIsFramedOffCenter() {
        val camera=ArchivePose.Camera(doubleArrayOf(0.0,0.0,10.0),doubleArrayOf(0.0,0.0,0.0),5.0)
        assertEquals(10.0,ArchivePose.focusDistance(camera,doubleArrayOf(0.0,0.0,0.0)),1e-9)
        assertEquals(10.0,ArchivePose.focusDistance(camera,doubleArrayOf(20.0,15.0,0.0)),1e-9)
        assertEquals(.1,ArchivePose.focusDistance(camera,doubleArrayOf(0.0,0.0,11.0)),1e-9)
    }
    @Test fun openingCornerTracksGpuHeightAndReleasesToTheShelfContinuously() {
        val samples=arrayOf(
            doubleArrayOf(0.0,0.0,25.05,1.2234059929863417),
            doubleArrayOf(0.0,0.0,25.4,2.14063738250456),
            doubleArrayOf(0.0,0.0,25.75,2.128282640313845),
            doubleArrayOf(2.0,-1.0,25.4,1.9012090831332218))
        for(s in samples) assertEquals(s[3],ArchivePose.openingHeight(s[0],s[1],s[2]),1e-8)
        for(row in -15..15) for(lane in -3..3)
            assertEquals(ArchivePose.shoulder(row.toDouble(),lane.toDouble()),ArchivePose.openingHeight(row.toDouble(),lane.toDouble(),27.12),1e-8)
        assertEquals(-23.0,ArchivePose.introEntryZ(21.92),1e-9)
        assertEquals(-5.75,ArchivePose.introEntryZ(22.295),1e-9)
        assertEquals(0.0,ArchivePose.introEntryZ(22.67),1e-9)
        for((w,h) in listOf(840 to 360,749 to 360,360 to 749)) for(time in listOf(25.05,25.4,26.72,27.12)) {
            val before=ArchivePose.camera(w,h,0.0,0.0,time-1e-6)
            val after=ArchivePose.camera(w,h,0.0,0.0,time+1e-6)
            assertTrue((0..2).all { abs(before.position[it]-after.position[it])<.001 })
        }
    }
    @Test fun cameraDoesNotEasePlacementTwiceAndRetargetedRotationKeepsItsPosition() {
        val motion = ArchiveCameraMotion()
        val landscape = ArchivePose.camera(749,360,0.0,0.0)
        val portrait = ArchivePose.camera(360,749,0.0,0.0)
        assertEquals(landscape,motion.sample(landscape,0.0))
        motion.resize(1.0)
        assertArrayEquals(landscape.position,motion.sample(portrait,1.0).position,1e-12)
        val midway = motion.sample(portrait,1.16)
        assertTrue(motion.moving)
        motion.resize(1.16)
        assertArrayEquals(midway.position,motion.sample(landscape,1.16).position,1e-12)
        assertEquals(landscape,motion.sample(landscape,1.49))
        assertFalse(motion.moving)
        val detail = ArchivePose.camera(749,360,1.0,0.0)
        assertEquals(detail,motion.sample(detail,1.5))
    }
    @Test fun placementMatchesUpstreamQuinticAndKeepsDerivativesOnReverse() {
        val value=ArchiveScalar()
        value.to(1.0,0.0,ArchivePose.PLACEMENT_SECONDS)
        for(i in 0..100) {
            val t=i/100.0
            assertEquals(ArchivePose.smooth(t),value.sample(t*ArchivePose.PLACEMENT_SECONDS).value,1e-10)
        }
        val before=value.sample(.5)
        value.to(0.0,.5,ArchivePose.PLACEMENT_SECONDS)
        val after=value.sample(.5)
        assertEquals(before.value,after.value,1e-10)
        assertEquals(before.velocity,after.velocity,1e-10)
        assertEquals(before.acceleration,after.acceleration,1e-10)
        assertEquals(ArchiveScalar.Sample(0.0),value.sample(3.0))
    }
    @Test fun cameraSpringIsIndependentOfFrameRate() {
        val results=listOf(20,30,60,120).map { fps ->
            val value=ArchiveSpring()
            repeat(fps*2) { value.update(140.0,1.0/fps) }
            value.value to value.velocity
        }
        results.forEach { assertEquals(results[0].first,it.first,1e-10); assertEquals(results[0].second,it.second,1e-10) }
    }
    @Test fun portraitLandscapeAndOpeningProduceFiniteContinuousCameras() {
        for((width,height) in listOf(749 to 360,360 to 749,1920 to 1080)) {
            for(step in 0..100) {
                val camera=ArchivePose.camera(width,height,step/100.0,0.0)
                assertTrue((camera.position+camera.aim).all { it.isFinite() })
                assertTrue(camera.span in 5.8..40.0)
            }
            val opening=ArchivePose.camera(width,height,0.0,0.0,27.12)
            val archive=ArchivePose.camera(width,height,0.0,0.0)
            for(i in 0..2) { assertEquals(archive.position[i],opening.position[i],1e-6); assertEquals(archive.aim[i],opening.aim[i],1e-6) }
        }
        // source scene.ts: 72-unit inspection distance, 8-degree yaw, 20-degree elevation.
        val detail=ArchivePose.camera(1920,1080,1.0,0.0)
        val direction=DoubleArray(3) { (detail.position[it]-detail.aim[it])/72 }
        assertEquals(-sin(8*PI/180)*cos(20*PI/180),direction[0],1e-10)
        assertEquals(sin(20*PI/180),direction[1],1e-10)
    }
}
