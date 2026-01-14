import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AlertManager,
  type AlertManagerConfig,
  type AlertEvent
} from '../../src/core/AlertManager.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'
import type { Alert, IAlertStore, AlertFilter } from '../../src/types.js'

/**
 * In-memory mock store for testing persistence.
 */
class MockAlertStore implements IAlertStore {
  private alerts = new Map<string, Alert>()
  initialized = false
  closed = false

  initialize(): Promise<void> {
    this.initialized = true
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  save(alert: Alert): Promise<void> {
    this.alerts.set(alert.id, { ...alert })
    return Promise.resolve()
  }

  get(id: string): Promise<Alert | null> {
    return Promise.resolve(this.alerts.get(id) ?? null)
  }

  getAll(filter?: AlertFilter): Promise<Alert[]> {
    let alerts = Array.from(this.alerts.values())

    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state]
      alerts = alerts.filter((a) => states.includes(a.state))
    }

    if (filter?.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
      alerts = alerts.filter((a) => priorities.includes(a.priority))
    }

    if (filter?.category) {
      alerts = alerts.filter((a) => a.category === filter.category)
    }

    if (filter?.stale !== undefined) {
      alerts = alerts.filter((a) => a.stale === filter.stale)
    }

    return Promise.resolve(alerts)
  }

  update(alert: Alert): Promise<void> {
    this.alerts.set(alert.id, { ...alert })
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    this.alerts.delete(id)
    return Promise.resolve()
  }

  // Test helper methods
  getStoredAlert(id: string): Alert | undefined {
    return this.alerts.get(id)
  }

  getStoredAlertCount(): number {
    return this.alerts.size
  }
}

describe('AlertManager', () => {
  let manager: AlertManager
  let fakeTimers: FakeTimerFunctions
  let events: AlertEvent[]
  let defaultConfig: AlertManagerConfig

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
    events = []
    defaultConfig = {
      escalation: {
        enabled: true,
        timeoutSeconds: 300
      },
      silencing: {
        alarmMaxSeconds: 30,
        emergencyMaxSeconds: 10
      },
      sourceTimeout: {
        markStaleAfterSeconds: 60
      }
    }
    manager = new AlertManager(defaultConfig, fakeTimers)
    manager.on('alert', (event: AlertEvent) => events.push(event))
  })

  afterEach(() => {
    manager.stop()
  })

  describe('raiseAlert', () => {
    it('should create a new alert with correct initial state', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(alert.id).toBeDefined()
      expect(alert.sourceId).toBe('test-source')
      expect(alert.priority).toBe('alarm')
      expect(alert.state).toBe('unacknowledged')
      expect(alert.condition).toBe(true)
      expect(alert.message).toBe('Test alert')
      expect(alert.sourceOnline).toBe(true)
      expect(alert.stale).toBe(false)
    })

    it('should emit alert-raised event', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('raised')
      expect(events[0].alert.message).toBe('Test alert')
    })

    it('should store alert in internal collection', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const retrieved = manager.getAlert(alert.id)
      expect(retrieved).toEqual(alert)
    })

    it('should start escalation timer for warning priority', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      // Advance time to trigger escalation
      fakeTimers.advanceTime(300 * 1000)

      const updated = manager.getAlert(alert.id)
      expect(updated?.priority).toBe('alarm')
    })

    it('should not start escalation timer for alarm priority', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alarm'
      })

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should support optional category and data', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Engine alert',
        category: 'engine',
        data: { temperature: 95, threshold: 90 }
      })

      expect(alert.category).toBe('engine')
      expect(alert.data).toEqual({ temperature: 95, threshold: 90 })
    })

    it('should support latching alerts', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Latching alert',
        latching: true
      })

      expect(alert.latching).toBe(true)
    })
  })

  describe('acknowledgeAlert', () => {
    it('should transition unacknowledged to acknowledged', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const result = await manager.acknowledgeAlert(alert.id, 'user-1')

      expect(result.alert?.state).toBe('acknowledged')
      expect(result.alert?.acknowledgedBy).toBe('user-1')
      expect(result.alert?.acknowledgedAt).toBeDefined()
    })

    it('should emit alert-acknowledged event', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      events = [] // Clear raise event

      await manager.acknowledgeAlert(alert.id)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('acknowledged')
    })

    it('should cancel escalation timer on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.acknowledgeAlert(alert.id)

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should clear RTN-unacknowledged alert on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.clearCondition(alert.id)

      const result = await manager.acknowledgeAlert(alert.id)

      expect(result.cleared).toBe(true)
      expect(manager.getAlert(alert.id)).toBeNull()
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.acknowledgeAlert('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('silenceAlert', () => {
    it('should set silenced flag and silencedUntil', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const silenced = await manager.silenceAlert(alert.id, 30000)

      expect(silenced.silenced).toBe(true)
      expect(silenced.silencedUntil).toBeDefined()
    })

    it('should emit alert-silenced event', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      events = []

      await manager.silenceAlert(alert.id)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('silenced')
    })

    it('should use default duration from config for alarm', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const silenced = await manager.silenceAlert(alert.id)

      // Default is 30 seconds for alarm
      if (silenced.silencedUntil === undefined) {
        throw new Error('Expected silencedUntil to be defined')
      }
      const silencedUntil = new Date(silenced.silencedUntil).getTime()
      const now = Date.now()
      expect(silencedUntil - now).toBeLessThanOrEqual(30000)
      expect(silencedUntil - now).toBeGreaterThan(29000)
    })

    it('should use shorter duration for emergency', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'emergency',
        message: 'Test emergency'
      })

      const silenced = await manager.silenceAlert(alert.id)

      // Default is 10 seconds for emergency
      if (silenced.silencedUntil === undefined) {
        throw new Error('Expected silencedUntil to be defined')
      }
      const silencedUntil = new Date(silenced.silencedUntil).getTime()
      const now = Date.now()
      expect(silencedUntil - now).toBeLessThanOrEqual(10000)
      expect(silencedUntil - now).toBeGreaterThan(9000)
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.silenceAlert('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('clearCondition', () => {
    it('should transition acknowledged alert to cleared', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)
      const result = await manager.clearCondition(alert.id)

      expect(result.cleared).toBe(true)
      expect(manager.getAlert(alert.id)).toBeNull()
    })

    it('should transition unacknowledged to rtn-unacknowledged', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const result = await manager.clearCondition(alert.id)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('rtn-unacknowledged')
    })

    it('should auto-clear caution alerts', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'caution',
        message: 'Test caution'
      })

      const result = await manager.clearCondition(alert.id)

      expect(result.cleared).toBe(true)
      expect(manager.getAlert(alert.id)).toBeNull()
    })

    it('should emit alert-cleared event when removed', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      await manager.acknowledgeAlert(alert.id)
      events = []

      await manager.clearCondition(alert.id)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('cleared')
    })

    it('should cancel escalation timer when clearing warning', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.clearCondition(alert.id)

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.clearCondition('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('escalation', () => {
    it('should escalate warning to alarm after timeout', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })
      events = []

      fakeTimers.advanceTime(300 * 1000)

      const updated = manager.getAlert(alert.id)
      expect(updated?.priority).toBe('alarm')
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('escalated')
    })

    it('should not escalate if acknowledged before timeout', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      await manager.acknowledgeAlert(alert.id)
      fakeTimers.advanceTime(300 * 1000)

      const updated = manager.getAlert(alert.id)
      expect(updated?.priority).toBe('warning')
    })

    it('should not escalate if disabled in config', async () => {
      manager.stop()
      manager = new AlertManager(
        { ...defaultConfig, escalation: { enabled: false, timeoutSeconds: 300 } },
        fakeTimers
      )

      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      fakeTimers.advanceTime(300 * 1000)

      const updated = manager.getAlert(alert.id)
      expect(updated?.priority).toBe('warning')
    })
  })

  describe('source tracking', () => {
    it('should mark alert as stale when source goes offline', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      manager.markSourceOffline('test-source')

      const updated = manager.getAlert(alert.id)
      expect(updated?.stale).toBe(true)
      expect(updated?.sourceOnline).toBe(false)
    })

    it('should update lastSourceUpdate on heartbeat', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const originalUpdate = alert.lastSourceUpdate

      // Advance time slightly
      await new Promise((resolve) => setTimeout(resolve, 10))

      manager.sourceHeartbeat('test-source')

      const updated = manager.getAlert(alert.id)
      if (updated === null) {
        throw new Error('Expected alert to exist')
      }
      expect(new Date(updated.lastSourceUpdate).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdate).getTime()
      )
    })

    it('should mark source back online on heartbeat after offline', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      manager.markSourceOffline('test-source')
      manager.sourceHeartbeat('test-source')

      const updated = manager.getAlert(alert.id)
      expect(updated?.sourceOnline).toBe(true)
      // Note: stale stays true once set (operator must clear)
    })

    it('should only affect alerts from specified source', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })

      const alert2 = await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      manager.markSourceOffline('source-1')

      const updated2 = manager.getAlert(alert2.id)
      expect(updated2?.stale).toBe(false)
      expect(updated2?.sourceOnline).toBe(true)
    })
  })

  describe('getAlerts', () => {
    it('should return all active alerts', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'warning',
        message: 'Alert 2'
      })

      const alerts = manager.getAlerts()

      expect(alerts).toHaveLength(2)
    })

    it('should filter by state', async () => {
      const alert1 = await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      await manager.acknowledgeAlert(alert1.id)

      const unacked = manager.getAlerts({ state: 'unacknowledged' })
      const acked = manager.getAlerts({ state: 'acknowledged' })

      expect(unacked).toHaveLength(1)
      expect(acked).toHaveLength(1)
    })

    it('should filter by priority', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'warning',
        message: 'Alert 2'
      })

      const alarms = manager.getAlerts({ priority: 'alarm' })

      expect(alarms).toHaveLength(1)
      expect(alarms[0].priority).toBe('alarm')
    })

    it('should filter by category', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1',
        category: 'engine'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2',
        category: 'navigation'
      })

      const engineAlerts = manager.getAlerts({ category: 'engine' })

      expect(engineAlerts).toHaveLength(1)
      expect(engineAlerts[0].category).toBe('engine')
    })
  })

  describe('duplicate handling', () => {
    it('should update existing alert from same source with same message', async () => {
      const alert1 = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert',
        data: { value: 1 }
      })

      const alert2 = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert',
        data: { value: 2 }
      })

      // Same alert ID - updated, not duplicated
      expect(alert2.id).toBe(alert1.id)
      expect(alert2.data).toEqual({ value: 2 })
      expect(manager.getAlerts()).toHaveLength(1)
    })

    it('should create separate alerts for different messages from same source', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Alert 1'
      })

      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getAlerts()).toHaveLength(2)
    })

    it('should emit alert-updated event for duplicate', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })
      events = []

      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('updated')
    })
  })

  describe('persistence with store', () => {
    let store: MockAlertStore

    beforeEach(() => {
      store = new MockAlertStore()
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, store)
      manager.on('alert', (event: AlertEvent) => events.push(event))
    })

    it('should save alert to store on raise', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(store.getStoredAlert(alert.id)).toBeDefined()
      expect(store.getStoredAlert(alert.id)?.message).toBe('Test alert')
    })

    it('should update store on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)

      expect(store.getStoredAlert(alert.id)?.state).toBe('acknowledged')
    })

    it('should delete from store when alert is cleared', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)
      await manager.clearCondition(alert.id)

      expect(store.getStoredAlert(alert.id)).toBeUndefined()
    })

    it('should work without store (in-memory only)', async () => {
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers) // No store
      manager.on('alert', (event: AlertEvent) => events.push(event))

      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(manager.getAlert(alert.id)).toBeDefined()
    })
  })

  describe('stop', () => {
    it('should cancel all escalation timers on stop', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'warning',
        message: 'Warning 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'warning',
        message: 'Warning 2'
      })

      expect(fakeTimers.getPendingCount()).toBe(2)

      manager.stop()

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should not emit events after stop', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })
      events = []

      manager.stop()
      fakeTimers.advanceTime(300 * 1000)

      expect(events).toHaveLength(0)
    })
  })

  describe('silenceAll', () => {
    it('should silence all unacknowledged alerts', async () => {
      const alert1 = await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      const alert2 = await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      manager.silenceAll()

      expect(manager.getAlert(alert1.id)?.silenced).toBe(true)
      expect(manager.getAlert(alert2.id)?.silenced).toBe(true)
    })
  })

  describe('getActiveAlertCount', () => {
    it('should return count of active alerts', async () => {
      expect(manager.getActiveAlertCount()).toBe(0)

      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })

      expect(manager.getActiveAlertCount()).toBe(1)

      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getActiveAlertCount()).toBe(2)
    })
  })

  describe('getUnacknowledgedCount', () => {
    it('should return count of unacknowledged alerts', async () => {
      const alert1 = await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getUnacknowledgedCount()).toBe(2)

      await manager.acknowledgeAlert(alert1.id)

      expect(manager.getUnacknowledgedCount()).toBe(1)
    })
  })

  describe('getIndicationState', () => {
    it('should return correct indication state', async () => {
      // No alerts
      let indication = manager.getIndicationState()
      expect(indication.audible).toBe(false)
      expect(indication.priority).toBeNull()
      expect(indication.flash).toBe(false)
      expect(indication.unacknowledgedCount).toBe(0)

      // Add unacknowledged alarm
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      indication = manager.getIndicationState()
      expect(indication.audible).toBe(true)
      expect(indication.priority).toBe('alarm')
      expect(indication.flash).toBe(true)
      expect(indication.unacknowledgedCount).toBe(1)

      // Silence the alert
      await manager.silenceAlert(alert.id)

      indication = manager.getIndicationState()
      expect(indication.silenced).toBe(true)
      expect(indication.audible).toBe(false)
    })

    it('should return highest priority among unacknowledged', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'warning',
        message: 'Warning'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alarm'
      })

      const indication = manager.getIndicationState()
      expect(indication.priority).toBe('alarm')
    })
  })
})
