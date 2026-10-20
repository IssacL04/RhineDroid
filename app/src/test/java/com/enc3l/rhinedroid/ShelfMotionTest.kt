package com.enc3l.rhinedroid

import org.junit.Assert.*
import org.junit.Test

class ShelfMotionTest {
    @Test fun searchJumpResetsTheWholePoolWithoutCarryingAnIncomingColumn() {
        val library=listOf(List(1000){"a$it"},List(120){"b$it"},List(800){"c$it"})
        val motion=ShelfMotion()
        motion.retarget(ShelfLayout.cells(library,0,10,true),0f,0f,0f)
        motion.retarget(ShelfLayout.cells(library,0,11,true),0f,1f,1.4f,dz=.62f)
        motion.retarget(ShelfLayout.cells(library,2,720,true),0f,1.3f,0f)
        for(slot in 0 until ShelfLayout.COUNT) for(axis in 0..2) {
            val n=slot*4+axis
            assertEquals(motion.target[n],motion.sample(slot,axis,1.3f).position,0f)
            assertEquals(0f,motion.velocity[n],0f)
            assertEquals(0f,motion.acceleration[n],0f)
        }
    }
    private val columns = listOf(List(100) { "a$it" }, List(100) { "b$it" })
    @Test fun slideDoesNotAddBounceToTheOriginalShoulderProfile() {
        val motion = ShelfMotion()
        motion.retarget(ShelfLayout.cells(columns, 0, 40, true), 0f, 0f, 0f)
        motion.retarget(ShelfLayout.cells(columns, 0, 41, true), 0f, 1f, 1.4f, dz = .62f)
        val slot = ShelfLayout.SELECTED
        val initial=motion.sample(slot+3,1,1f).position
        val final=motion.sample(slot+3,1,3f).position
        var last = .62f
        for (step in 0..100) {
            val now = 1f + step / 100f * 1.4f
            val z = motion.sample(slot, 2, now).position
            assertTrue(z <= last + .0001f && z >= -.0001f)
            last = z
            assertTrue(motion.sample(slot+3,1,now).position in (minOf(initial,final)-.0001f)..(maxOf(initial,final)+.0001f))
        }
        val end = motion.sample(slot, 2, 2.5f)
        assertEquals(0f, end.position, 0f); assertEquals(0f, end.velocity, 0f); assertEquals(0f, end.acceleration, 0f)
    }
    @Test fun rapidRetargetPreservesPositionVelocityAndAcceleration() {
        val motion = ShelfMotion()
        motion.retarget(ShelfLayout.cells(columns, 0, 40, true), 0f, 0f, 0f)
        motion.retarget(ShelfLayout.cells(columns, 0, 41, true), 0f, 1f, 1.4f, dz = .62f)
        val before = (0..2).map { motion.sample(ShelfLayout.SELECTED + 1, it, 1.5f) }
        motion.retarget(ShelfLayout.cells(columns, 0, 42, true), 0f, 1.5f, 1.4f, dz = .62f)
        for (axis in 0..2) {
            val after = motion.sample(ShelfLayout.SELECTED, axis, 1.5f)
            assertEquals(before[axis].position, after.position, .0001f)
            assertEquals(before[axis].velocity, after.velocity, .0001f)
            assertEquals(before[axis].acceleration, after.acceleration, .0001f)
        }
    }
    @Test fun directionalWrapKeepsTravelDirectionAndOriginalTiming() {
        assertEquals(100, ShelfMotion.occurrence(0, 99, 100, 1))
        assertEquals(-1, ShelfMotion.occurrence(99, 0, 100, -1))
        assertEquals(1, ShelfMotion.occurrence(1, 0, 2, 1))
        assertEquals(-1, ShelfMotion.occurrence(1, 0, 2, -1))
        assertEquals(1.4f, ShelfMotion.duration(0f, 1f), 0f)
        assertEquals(2.4f, ShelfMotion.duration(20f, 100f), 0f)
    }
}
