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

  // Pre-populate store with alerts for testing loadFromStore
  prePopulate(alerts: Alert[]): void {
    for (const alert of alerts) {
      this.alerts.set(alert.id, { ...alert })
    }
  }

  clear(): void {
    this.alerts.clear()
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

      await manager.silenceAll()

      expect(manager.getAlert(alert1.id)?.silenced).toBe(true)
      expect(manager.getAlert(alert2.id)?.silenced).toBe(true)
    })

    it('should emit silenced events for each alert', async () => {
      await manager.raiseAlert({
        sourceId: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        sourceId: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })
      events = []

      await manager.silenceAll()

      const silencedEvents = events.filter((e) => e.type === 'silenced')
      expect(silencedEvents).toHaveLength(2)
    })

    it('should not silence already silenced alerts', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id)
      events = []

      await manager.silenceAll()

      expect(events.filter((e) => e.type === 'silenced')).toHaveLength(0)
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

  describe('unsilenceAlert', () => {
    it('should remove silenced flag from alert', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id)
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)

      const unsilenced = await manager.unsilenceAlert(alert.id)

      expect(unsilenced.silenced).toBe(false)
      expect(unsilenced.silencedUntil).toBeUndefined()
    })

    it('should emit unsilenced event', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      await manager.silenceAlert(alert.id)
      events = []

      await manager.unsilenceAlert(alert.id)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('unsilenced')
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.unsilenceAlert('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('silence expiration', () => {
    it('should automatically unsilence alert after duration', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 5000) // 5 second silence
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)

      fakeTimers.advanceTime(5000)

      expect(manager.getAlert(alert.id)?.silenced).toBe(false)
    })

    it('should emit unsilenced event on expiration', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 5000)
      events = []

      fakeTimers.advanceTime(5000)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('unsilenced')
    })

    it('should cancel expiration timer when manually unsilenced', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 5000)
      await manager.unsilenceAlert(alert.id)
      events = []

      fakeTimers.advanceTime(5000)

      // Should not emit another unsilenced event
      expect(events).toHaveLength(0)
    })

    it('should cancel expiration timer when alert is cleared', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 5000)
      await manager.acknowledgeAlert(alert.id)
      await manager.clearCondition(alert.id)

      // Should not throw when timer fires for non-existent alert
      expect(() => {
        fakeTimers.advanceTime(5000)
      }).not.toThrow()
    })
  })

  describe('clearStaleFlag', () => {
    it('should clear stale flag on alert', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      manager.markSourceOffline('test-source')
      expect(manager.getAlert(alert.id)?.stale).toBe(true)

      const updated = await manager.clearStaleFlag(alert.id)

      expect(updated.stale).toBe(false)
      expect(manager.getAlert(alert.id)?.stale).toBe(false)
    })

    it('should emit updated event', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      manager.markSourceOffline('test-source')
      events = []

      await manager.clearStaleFlag(alert.id)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('updated')
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.clearStaleFlag('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('priority escalation on update', () => {
    it('should allow source to escalate priority', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      const updated = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(updated.id).toBe(alert.id)
      expect(updated.priority).toBe('alarm')
    })

    it('should not allow priority reduction', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const updated = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(updated.id).toBe(alert.id)
      expect(updated.priority).toBe('alarm') // Stays at alarm
    })

    it('should cancel escalation timer when priority is escalated by source', async () => {
      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Escalation timer should be cancelled since priority was manually escalated
      expect(fakeTimers.getPendingCount()).toBe(0)
    })
  })

  describe('escalation persistence', () => {
    let store: MockAlertStore

    beforeEach(() => {
      store = new MockAlertStore()
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, store)
      manager.on('alert', (event: AlertEvent) => events.push(event))
    })

    it('should persist escalation to store', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      fakeTimers.advanceTime(300 * 1000)

      // Give async store.update a chance to complete
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(store.getStoredAlert(alert.id)?.priority).toBe('alarm')
    })
  })

  describe('edge cases', () => {
    it('should not raise alerts after stop', async () => {
      manager.stop()

      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Alert is still created in memory but no events are emitted
      expect(alert).toBeDefined()
      expect(events.filter((e) => e.type === 'raised')).toHaveLength(0)
    })

    it('should handle silencing an already silenced alert', async () => {
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 10000)
      const firstSilencedUntil = manager.getAlert(alert.id)?.silencedUntil

      await manager.silenceAlert(alert.id, 20000)
      const secondSilencedUntil = manager.getAlert(alert.id)?.silencedUntil

      // Second silence should update the silencedUntil
      expect(secondSilencedUntil).not.toBe(firstSilencedUntil)
    })
  })

  describe('loadFromStore', () => {
    let store: MockAlertStore

    beforeEach(() => {
      store = new MockAlertStore()
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, store)
      manager.on('alert', (event: AlertEvent) => events.push(event))
    })

    function createStoredAlert(overrides: Partial<Alert> = {}): Alert {
      const now = new Date().toISOString()
      return {
        id: `stored-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
        sourceId: 'stored-source',
        priority: 'alarm',
        state: 'unacknowledged',
        condition: true,
        latching: false,
        silenced: false,
        message: 'Stored alert',
        raisedAt: now,
        sourceOnline: true,
        lastSourceUpdate: now,
        stale: false,
        ...overrides
      }
    }

    it('should load alerts from store into memory', async () => {
      const alert1 = createStoredAlert({ id: 'stored-1', message: 'Alert 1' })
      const alert2 = createStoredAlert({ id: 'stored-2', message: 'Alert 2' })
      store.prePopulate([alert1, alert2])

      await manager.loadFromStore()

      expect(manager.getActiveAlertCount()).toBe(2)
      expect(manager.getAlert('stored-1')?.message).toBe('Alert 1')
      expect(manager.getAlert('stored-2')?.message).toBe('Alert 2')
    })

    it('should rebuild alert index for duplicate detection', async () => {
      const alert = createStoredAlert({
        id: 'stored-1',
        sourceId: 'test-source',
        message: 'Test message'
      })
      store.prePopulate([alert])

      await manager.loadFromStore()

      // Raising an alert with the same source+message should update the existing one
      const updated = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Test message'
      })

      // Should be the same alert, not a new one
      expect(updated.id).toBe('stored-1')
      expect(manager.getActiveAlertCount()).toBe(1)
    })

    it('should restart escalation timers for unacknowledged warnings', async () => {
      const warningAlert = createStoredAlert({
        id: 'warning-1',
        priority: 'warning',
        state: 'unacknowledged'
      })
      store.prePopulate([warningAlert])

      await manager.loadFromStore()

      // Should have started an escalation timer
      expect(fakeTimers.getPendingCount()).toBe(1)

      // Advance time to trigger escalation
      fakeTimers.advanceTime(300 * 1000)

      // Should have escalated to alarm
      expect(manager.getAlert('warning-1')?.priority).toBe('alarm')
    })

    it('should account for elapsed time when restarting escalation timers', async () => {
      // Create a warning that was raised 250 seconds ago (50 seconds remaining)
      const pastRaisedAt = new Date(Date.now() - 250 * 1000).toISOString()
      const warningAlert = createStoredAlert({
        id: 'old-warning',
        priority: 'warning',
        state: 'unacknowledged',
        raisedAt: pastRaisedAt
      })
      store.prePopulate([warningAlert])

      await manager.loadFromStore()

      // Timer should be set for remaining ~50 seconds, not full 300 seconds
      expect(fakeTimers.getPendingCount()).toBe(1)

      // Should NOT escalate after 40 seconds (still 10 seconds remaining)
      fakeTimers.advanceTime(40 * 1000)
      expect(manager.getAlert('old-warning')?.priority).toBe('warning')

      // Should escalate after another 20 seconds (total 60 seconds, past remaining 50)
      fakeTimers.advanceTime(20 * 1000)
      expect(manager.getAlert('old-warning')?.priority).toBe('alarm')
    })

    it('should immediately escalate warnings that have exceeded timeout', async () => {
      // Create a warning that was raised 400 seconds ago (already past 300s timeout)
      const oldRaisedAt = new Date(Date.now() - 400 * 1000).toISOString()
      const oldWarning = createStoredAlert({
        id: 'very-old-warning',
        priority: 'warning',
        state: 'unacknowledged',
        raisedAt: oldRaisedAt
      })
      store.prePopulate([oldWarning])

      await manager.loadFromStore()

      // Should have escalated immediately (no pending timer)
      expect(fakeTimers.getPendingCount()).toBe(0)
      expect(manager.getAlert('very-old-warning')?.priority).toBe('alarm')
    })

    it('should not start escalation timers for caution priority', async () => {
      const cautionAlert = createStoredAlert({
        id: 'caution-1',
        priority: 'caution',
        state: 'unacknowledged'
      })
      store.prePopulate([cautionAlert])

      await manager.loadFromStore()

      // Caution alerts don't escalate
      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should not start escalation timers for rtn-unacknowledged state', async () => {
      const rtnWarning = createStoredAlert({
        id: 'rtn-warning',
        priority: 'warning',
        state: 'rtn-unacknowledged'
      })
      store.prePopulate([rtnWarning])

      await manager.loadFromStore()

      // RTN alerts have cleared condition, no need to escalate
      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should not start escalation timers for acknowledged alerts', async () => {
      const acknowledgedWarning = createStoredAlert({
        id: 'warning-1',
        priority: 'warning',
        state: 'acknowledged'
      })
      store.prePopulate([acknowledgedWarning])

      await manager.loadFromStore()

      // Should not have started an escalation timer
      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should restart silence expiration timers for silenced alerts', async () => {
      const futureTime = new Date(Date.now() + 15000).toISOString() // 15 seconds from now
      const silencedAlert = createStoredAlert({
        id: 'silenced-1',
        silenced: true,
        silencedUntil: futureTime
      })
      store.prePopulate([silencedAlert])

      await manager.loadFromStore()

      // Should have started a silence timer
      expect(fakeTimers.getPendingCount()).toBe(1)

      // Verify it unsilences when time expires
      fakeTimers.advanceTime(16000)
      expect(manager.getAlert('silenced-1')?.silenced).toBe(false)
    })

    it('should immediately unsilence alerts with expired silence time', async () => {
      const pastTime = new Date(Date.now() - 1000).toISOString() // 1 second ago
      const expiredSilencedAlert = createStoredAlert({
        id: 'expired-silenced',
        silenced: true,
        silencedUntil: pastTime
      })
      store.prePopulate([expiredSilencedAlert])

      await manager.loadFromStore()

      // Should have immediately unsilenced
      expect(manager.getAlert('expired-silenced')?.silenced).toBe(false)
    })

    it('should emit unsilenced event for expired silences', async () => {
      const pastTime = new Date(Date.now() - 1000).toISOString()
      const expiredSilencedAlert = createStoredAlert({
        id: 'expired-with-event',
        silenced: true,
        silencedUntil: pastTime
      })
      store.prePopulate([expiredSilencedAlert])

      await manager.loadFromStore()

      // Should have emitted unsilenced event
      const unsilencedEvents = events.filter((e) => e.type === 'unsilenced')
      expect(unsilencedEvents).toHaveLength(1)
      expect(unsilencedEvents[0].alert.id).toBe('expired-with-event')
    })

    it('should leave silenced alerts without silencedUntil as silenced', async () => {
      const silencedWithoutUntil = createStoredAlert({
        id: 'silenced-no-until',
        silenced: true
        // silencedUntil intentionally undefined
      })
      store.prePopulate([silencedWithoutUntil])

      await manager.loadFromStore()

      // Should remain silenced (no timer started, no unsilencing)
      expect(manager.getAlert('silenced-no-until')?.silenced).toBe(true)
      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should handle empty store gracefully', async () => {
      await manager.loadFromStore()

      expect(manager.getActiveAlertCount()).toBe(0)
    })

    it('should handle store.getAll() failure gracefully', async () => {
      store.getAll = () => {
        return Promise.reject(new Error('SQLite disk I/O error'))
      }

      await expect(manager.loadFromStore()).resolves.not.toThrow()
      expect(manager.getActiveAlertCount()).toBe(0)
    })

    it('should work without store configured', async () => {
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers) // No store

      // Should not throw
      await expect(manager.loadFromStore()).resolves.not.toThrow()
      expect(manager.getActiveAlertCount()).toBe(0)
    })

    it('should preserve all alert fields when loading', async () => {
      const fullAlert = createStoredAlert({
        id: 'full-alert',
        sourceId: 'source-123',
        priority: 'emergency',
        state: 'acknowledged',
        condition: false,
        latching: true,
        silenced: false,
        message: 'Full alert message',
        category: 'engine',
        data: { temperature: 95 },
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'user-1',
        context: 'vessels.self'
      })
      store.prePopulate([fullAlert])

      await manager.loadFromStore()

      const loaded = manager.getAlert('full-alert')
      expect(loaded).toEqual(fullAlert)
    })

    it('should survive manager restart with persisted alerts', async () => {
      // Create an alert
      const alert = await manager.raiseAlert({
        sourceId: 'test-source',
        priority: 'alarm',
        message: 'Persistent alert'
      })

      // Stop and create a new manager with the same store
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, store)

      // Load from store
      await manager.loadFromStore()

      // Alert should be restored
      expect(manager.getActiveAlertCount()).toBe(1)
      expect(manager.getAlert(alert.id)?.message).toBe('Persistent alert')
    })
  })
})
