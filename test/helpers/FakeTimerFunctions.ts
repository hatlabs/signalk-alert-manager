/**
 * Fake timer functions for testing EscalationTimer.
 *
 * Provides controllable time advancement for deterministic tests.
 */

import type { TimerFunctions, TimerHandle } from '../../src/core/EscalationTimer.js'

interface PendingTimer {
  callback: () => void
  expiresAt: number
}

/**
 * Fake implementation of TimerFunctions for testing.
 *
 * Allows tests to control time advancement and verify timer behavior
 * without relying on real wall-clock time.
 */
export class FakeTimerFunctions implements TimerFunctions {
  private nextId = 1
  private timers = new Map<number, PendingTimer>()
  private currentTime = 0

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++
    this.timers.set(id, { callback, expiresAt: this.currentTime + ms })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number)
  }

  /**
   * Advance time by the specified milliseconds and fire expired timers.
   * Timers are fired in order of expiration time.
   */
  advanceTime(ms: number): void {
    this.currentTime += ms

    // Collect expired timers
    const expired: { id: number; timer: PendingTimer }[] = []
    for (const [id, timer] of this.timers) {
      if (timer.expiresAt <= this.currentTime) {
        expired.push({ id, timer })
      }
    }

    // Sort by expiration time for deterministic ordering
    expired.sort((a, b) => a.timer.expiresAt - b.timer.expiresAt)

    // Fire callbacks after collecting (avoid mutation during iteration)
    for (const { id, timer } of expired) {
      this.timers.delete(id)
      timer.callback()
    }
  }

  /**
   * Get the count of pending (not yet fired) timers.
   */
  getPendingCount(): number {
    return this.timers.size
  }

  /**
   * Get the current simulated time in milliseconds.
   */
  getCurrentTime(): number {
    return this.currentTime
  }

  /**
   * Reset all state (timers and time).
   */
  reset(): void {
    this.timers.clear()
    this.currentTime = 0
    this.nextId = 1
  }
}
