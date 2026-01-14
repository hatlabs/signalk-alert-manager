import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  EscalationTimer,
  type EscalationEvent,
  type EscalationTimerConfig
} from '../../src/core/EscalationTimer.js'
import { FakeTimerFunctions } from '../../src/test/FakeTimerFunctions.js'

describe('EscalationTimer', () => {
  let timer: EscalationTimer
  let fakeTimers: FakeTimerFunctions
  let escalationEvents: EscalationEvent[]
  let defaultConfig: EscalationTimerConfig

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
    escalationEvents = []
    defaultConfig = { enabled: true, timeoutSeconds: 300 }
    timer = new EscalationTimer(defaultConfig, (event) => escalationEvents.push(event), fakeTimers)
  })

  afterEach(() => {
    timer.stop()
  })

  describe('startTimer', () => {
    it('should start timer for warning priority', () => {
      timer.startTimer('alert-1', 'warning')

      expect(timer.hasTimer('alert-1')).toBe(true)
      expect(timer.getActiveTimerCount()).toBe(1)
    })

    it('should not start timer for alarm priority', () => {
      timer.startTimer('alert-1', 'alarm')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should not start timer for emergency priority', () => {
      timer.startTimer('alert-1', 'emergency')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should not start timer for caution priority', () => {
      timer.startTimer('alert-1', 'caution')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should not start timer when escalation is disabled', () => {
      timer = new EscalationTimer(
        { enabled: false, timeoutSeconds: 300 },
        (event) => escalationEvents.push(event),
        fakeTimers
      )

      timer.startTimer('alert-1', 'warning')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should be idempotent - starting timer twice does not create duplicate', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-1', 'warning')

      expect(timer.getActiveTimerCount()).toBe(1)
      expect(fakeTimers.getPendingCount()).toBe(1)
    })

    it('should track multiple alerts independently', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-2', 'warning')
      timer.startTimer('alert-3', 'warning')

      expect(timer.getActiveTimerCount()).toBe(3)
      expect(timer.hasTimer('alert-1')).toBe(true)
      expect(timer.hasTimer('alert-2')).toBe(true)
      expect(timer.hasTimer('alert-3')).toBe(true)
    })
  })

  describe('escalation callback', () => {
    it('should fire escalation callback after timeout', () => {
      timer.startTimer('alert-1', 'warning')

      expect(escalationEvents).toHaveLength(0)

      fakeTimers.advanceTime(300 * 1000) // 300 seconds

      expect(escalationEvents).toHaveLength(1)
      expect(escalationEvents[0].alertId).toBe('alert-1')
      expect(escalationEvents[0].fromPriority).toBe('warning')
      expect(escalationEvents[0].toPriority).toBe('alarm')
    })

    it('should include timestamp in escalation event', () => {
      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(300 * 1000)

      expect(escalationEvents[0].timestamp).toBeDefined()
      // Timestamp should be a valid ISO string
      expect(() => new Date(escalationEvents[0].timestamp)).not.toThrow()
    })

    it('should remove timer after escalation fires', () => {
      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(300 * 1000)

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should not fire callback before timeout', () => {
      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(299 * 1000) // 1 second before timeout

      expect(escalationEvents).toHaveLength(0)
      expect(timer.hasTimer('alert-1')).toBe(true)
    })

    it('should use configured timeout duration', () => {
      timer = new EscalationTimer(
        { enabled: true, timeoutSeconds: 60 },
        (event) => escalationEvents.push(event),
        fakeTimers
      )

      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(59 * 1000)
      expect(escalationEvents).toHaveLength(0)

      fakeTimers.advanceTime(1 * 1000) // Now at 60 seconds
      expect(escalationEvents).toHaveLength(1)
    })

    it('should escalate multiple alerts independently', () => {
      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(100 * 1000)
      timer.startTimer('alert-2', 'warning')

      fakeTimers.advanceTime(200 * 1000) // 300s for alert-1, 200s for alert-2
      expect(escalationEvents).toHaveLength(1)
      expect(escalationEvents[0].alertId).toBe('alert-1')

      fakeTimers.advanceTime(100 * 1000) // 300s for alert-2
      expect(escalationEvents).toHaveLength(2)
      expect(escalationEvents[1].alertId).toBe('alert-2')
    })
  })

  describe('cancelTimer', () => {
    it('should prevent escalation callback when cancelled', () => {
      timer.startTimer('alert-1', 'warning')
      timer.cancelTimer('alert-1')

      fakeTimers.advanceTime(300 * 1000)

      expect(escalationEvents).toHaveLength(0)
    })

    it('should remove timer from tracking', () => {
      timer.startTimer('alert-1', 'warning')

      expect(timer.hasTimer('alert-1')).toBe(true)

      timer.cancelTimer('alert-1')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should be idempotent - cancelling non-existent timer is safe', () => {
      expect(() => {
        timer.cancelTimer('non-existent')
      }).not.toThrow()
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should only cancel the specified timer', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-2', 'warning')

      timer.cancelTimer('alert-1')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.hasTimer('alert-2')).toBe(true)
      expect(timer.getActiveTimerCount()).toBe(1)

      fakeTimers.advanceTime(300 * 1000)

      expect(escalationEvents).toHaveLength(1)
      expect(escalationEvents[0].alertId).toBe('alert-2')
    })
  })

  describe('stop', () => {
    it('should cancel all active timers', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-2', 'warning')
      timer.startTimer('alert-3', 'warning')

      timer.stop()

      expect(timer.getActiveTimerCount()).toBe(0)
      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should not fire callbacks after stop', () => {
      timer.startTimer('alert-1', 'warning')

      timer.stop()
      fakeTimers.advanceTime(300 * 1000)

      expect(escalationEvents).toHaveLength(0)
    })

    it('should prevent new timers from starting after stop', () => {
      timer.stop()

      timer.startTimer('alert-1', 'warning')

      expect(timer.hasTimer('alert-1')).toBe(false)
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should be idempotent - multiple stop calls are safe', () => {
      timer.startTimer('alert-1', 'warning')

      expect(() => {
        timer.stop()
        timer.stop()
        timer.stop()
      }).not.toThrow()
    })
  })

  describe('updateConfig', () => {
    it('should update timeout for new timers', () => {
      timer.updateConfig({ enabled: true, timeoutSeconds: 60 })

      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(60 * 1000)

      expect(escalationEvents).toHaveLength(1)
    })

    it('should cancel all timers when disabling escalation', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-2', 'warning')

      timer.updateConfig({ enabled: false, timeoutSeconds: 300 })

      expect(timer.getActiveTimerCount()).toBe(0)

      fakeTimers.advanceTime(300 * 1000)

      expect(escalationEvents).toHaveLength(0)
    })

    it('should allow new timers after re-enabling', () => {
      timer.updateConfig({ enabled: false, timeoutSeconds: 300 })
      timer.startTimer('alert-1', 'warning')
      expect(timer.hasTimer('alert-1')).toBe(false)

      timer.updateConfig({ enabled: true, timeoutSeconds: 300 })
      timer.startTimer('alert-2', 'warning')
      expect(timer.hasTimer('alert-2')).toBe(true)
    })

    it('should not affect existing timers when only changing timeout', () => {
      timer.startTimer('alert-1', 'warning')

      timer.updateConfig({ enabled: true, timeoutSeconds: 60 })

      // Original timer should still use 300s timeout
      fakeTimers.advanceTime(60 * 1000)
      expect(escalationEvents).toHaveLength(0)

      fakeTimers.advanceTime(240 * 1000) // Total 300s
      expect(escalationEvents).toHaveLength(1)
    })
  })

  describe('hasTimer', () => {
    it('should return true for active timer', () => {
      timer.startTimer('alert-1', 'warning')

      expect(timer.hasTimer('alert-1')).toBe(true)
    })

    it('should return false for non-existent timer', () => {
      expect(timer.hasTimer('non-existent')).toBe(false)
    })

    it('should return false after timer fires', () => {
      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(300 * 1000)

      expect(timer.hasTimer('alert-1')).toBe(false)
    })

    it('should return false after timer is cancelled', () => {
      timer.startTimer('alert-1', 'warning')
      timer.cancelTimer('alert-1')

      expect(timer.hasTimer('alert-1')).toBe(false)
    })
  })

  describe('getActiveTimerCount', () => {
    it('should return 0 when no timers active', () => {
      expect(timer.getActiveTimerCount()).toBe(0)
    })

    it('should return correct count of active timers', () => {
      timer.startTimer('alert-1', 'warning')
      expect(timer.getActiveTimerCount()).toBe(1)

      timer.startTimer('alert-2', 'warning')
      expect(timer.getActiveTimerCount()).toBe(2)

      timer.cancelTimer('alert-1')
      expect(timer.getActiveTimerCount()).toBe(1)
    })

    it('should decrease when timer fires', () => {
      timer.startTimer('alert-1', 'warning')
      timer.startTimer('alert-2', 'warning')

      fakeTimers.advanceTime(300 * 1000)

      expect(timer.getActiveTimerCount()).toBe(0)
    })
  })

  describe('edge cases', () => {
    it('should handle zero timeout (immediate escalation)', () => {
      timer = new EscalationTimer(
        { enabled: true, timeoutSeconds: 0 },
        (event) => escalationEvents.push(event),
        fakeTimers
      )

      timer.startTimer('alert-1', 'warning')

      // Advance by 0 to trigger immediate timer
      fakeTimers.advanceTime(0)

      expect(escalationEvents).toHaveLength(1)
    })

    it('should handle very large timeout values', () => {
      timer = new EscalationTimer(
        { enabled: true, timeoutSeconds: 86400 }, // 24 hours
        (event) => escalationEvents.push(event),
        fakeTimers
      )

      timer.startTimer('alert-1', 'warning')

      fakeTimers.advanceTime(86400 * 1000)

      expect(escalationEvents).toHaveLength(1)
    })

    it('should use default timer functions when not provided', () => {
      // This test just verifies the constructor accepts undefined timerFunctions
      const timerWithDefaults = new EscalationTimer(
        defaultConfig,
        (event) => escalationEvents.push(event)
        // No timerFunctions provided - uses defaults
      )

      // Just verify it doesn't throw
      expect(() => {
        timerWithDefaults.stop()
      }).not.toThrow()
    })
  })
})

describe('FakeTimerFunctions', () => {
  let fakeTimers: FakeTimerFunctions

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
  })

  it('should track pending timers', () => {
    const noop = (): void => {
      /* no-op for testing */
    }
    fakeTimers.setTimeout(noop, 1000)
    fakeTimers.setTimeout(noop, 2000)

    expect(fakeTimers.getPendingCount()).toBe(2)
  })

  it('should fire timers in order of expiration', () => {
    const order: number[] = []

    fakeTimers.setTimeout(() => order.push(2), 2000)
    fakeTimers.setTimeout(() => order.push(1), 1000)
    fakeTimers.setTimeout(() => order.push(3), 3000)

    fakeTimers.advanceTime(3000)

    expect(order).toEqual([1, 2, 3])
  })

  it('should allow clearing timers', () => {
    let called = false
    const handle = fakeTimers.setTimeout(() => {
      called = true
    }, 1000)

    fakeTimers.clearTimeout(handle)
    fakeTimers.advanceTime(1000)

    expect(called).toBe(false)
    expect(fakeTimers.getPendingCount()).toBe(0)
  })

  it('should track current time', () => {
    expect(fakeTimers.getCurrentTime()).toBe(0)

    fakeTimers.advanceTime(1000)
    expect(fakeTimers.getCurrentTime()).toBe(1000)

    fakeTimers.advanceTime(500)
    expect(fakeTimers.getCurrentTime()).toBe(1500)
  })

  it('should reset all state', () => {
    fakeTimers.setTimeout(() => {
      /* no-op for testing */
    }, 1000)
    fakeTimers.advanceTime(500)

    fakeTimers.reset()

    expect(fakeTimers.getPendingCount()).toBe(0)
    expect(fakeTimers.getCurrentTime()).toBe(0)
  })
})
