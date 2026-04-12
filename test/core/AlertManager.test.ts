import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AlertManager,
  type AlertManagerConfig,
  type AlertEvent
} from '../../src/core/AlertManager.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'
import type {
  Alert,
  IAlertStore,
  IHistoryStore,
  AlertFilter,
  HistoryEntry,
  HistoryQuery
} from '../../src/types.js'

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
        defaultMaxSilenceSeconds: 120,
        emergencyMaxSilenceSeconds: 30
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(alert.id).toBeDefined()
      expect(alert.$source).toBe('test-source')
      expect(alert.priority).toBe('alarm')
      expect(alert.state).toBe('unacknowledged')
      expect(alert.condition).toBe(true)
      expect(alert.message).toBe('Test alert')
      expect(alert.sourceOnline).toBe(true)
      expect(alert.stale).toBe(false)
    })

    it('should emit alert-raised event', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('raised')
      expect(events[0].alert.message).toBe('Test alert')
    })

    it('should store alert in internal collection', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const retrieved = manager.getAlert(alert.id)
      expect(retrieved).toEqual(alert)
    })

    it('should start escalation timer for warning priority', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alarm'
      })

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should support optional category and data', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.acknowledgeAlert(alert.id)

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should clear RTN-unacknowledged alert on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const silenced = await manager.silenceAlert(alert.id, 30000)

      expect(silenced.silenced).toBe(true)
      expect(silenced.silencedUntil).toBeDefined()
    })

    it('should emit alert-silenced event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const silenced = await manager.silenceAlert(alert.id)

      // Default is 120 seconds for alarm
      if (silenced.silencedUntil === undefined) {
        throw new Error('Expected silencedUntil to be defined')
      }
      const silencedUntil = new Date(silenced.silencedUntil).getTime()
      const now = Date.now()
      expect(silencedUntil - now).toBeLessThanOrEqual(120000)
      expect(silencedUntil - now).toBeGreaterThan(119000)
    })

    it('should use shorter duration for emergency', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'emergency',
        message: 'Test emergency'
      })

      const silenced = await manager.silenceAlert(alert.id)

      // Default is 30 seconds for emergency
      if (silenced.silencedUntil === undefined) {
        throw new Error('Expected silencedUntil to be defined')
      }
      const silencedUntil = new Date(silenced.silencedUntil).getTime()
      const now = Date.now()
      expect(silencedUntil - now).toBeLessThanOrEqual(30000)
      expect(silencedUntil - now).toBeGreaterThan(29000)
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.silenceAlert('non-existent')).rejects.toThrow('Alert not found')
    })
  })

  describe('clearCondition', () => {
    it('should transition acknowledged alert to cleared', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const result = await manager.clearCondition(alert.id)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('rtn-unacknowledged')
    })

    it('should auto-clear caution alerts', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'caution',
        message: 'Test caution'
      })

      const result = await manager.clearCondition(alert.id)

      expect(result.cleared).toBe(true)
      expect(manager.getAlert(alert.id)).toBeNull()
    })

    it('should emit alert-cleared event when removed', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })

      const alert2 = await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
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
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'warning',
        message: 'Alert 2'
      })

      const alerts = manager.getAlerts()

      expect(alerts).toHaveLength(2)
    })

    it('should filter by state', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
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
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'warning',
        message: 'Alert 2'
      })

      const alarms = manager.getAlerts({ priority: 'alarm' })

      expect(alarms).toHaveLength(1)
      expect(alarms[0].priority).toBe('alarm')
    })

    it('should filter by category', async () => {
      await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1',
        category: 'engine'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
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
    it('should update existing alert with same path', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert',
        data: { value: 1 }
      })

      const alert2 = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert',
        data: { value: 2 }
      })

      // Same alert ID - updated, not duplicated
      expect(alert2.id).toBe(alert1.id)
      expect(alert2.data).toEqual({ value: 2 })
      expect(manager.getAlerts()).toHaveLength(1)
    })

    it('should create separate alerts for different paths', async () => {
      await manager.raiseAlert({
        path: 'test.alert.msg1',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Alert 1'
      })

      await manager.raiseAlert({
        path: 'test.alert.msg2',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getAlerts()).toHaveLength(2)
    })

    it('should emit alert-updated event for duplicate', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })
      events = []

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('updated')
    })

    it('should dedup by path regardless of message', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'propulsion.main.coolantTemperature',
        $source: 'test-source',
        priority: 'warning',
        message: 'Coolant temp high'
      })

      const alert2 = await manager.raiseAlert({
        path: 'propulsion.main.coolantTemperature',
        $source: 'test-source',
        priority: 'warning',
        message: 'Coolant temp very high'
      })

      expect(alert2.id).toBe(alert1.id)
      expect(alert2.message).toBe('Coolant temp very high')
      expect(manager.getAlerts()).toHaveLength(1)
    })

    it('should dedup by path across different sources', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'propulsion.main.coolantTemperature',
        $source: 'source-A',
        priority: 'warning',
        message: 'From source A'
      })

      const alert2 = await manager.raiseAlert({
        path: 'propulsion.main.coolantTemperature',
        $source: 'source-B',
        priority: 'alarm',
        message: 'From source B'
      })

      expect(alert2.id).toBe(alert1.id)
      expect(manager.getAlerts()).toHaveLength(1)
    })

    it('should update message on re-raise', async () => {
      await manager.raiseAlert({
        path: 'engine.overheating',
        $source: 'test-source',
        priority: 'warning',
        message: 'Temperature 85°C'
      })

      const updated = await manager.raiseAlert({
        path: 'engine.overheating',
        $source: 'test-source',
        priority: 'warning',
        message: 'Temperature 92°C'
      })

      expect(updated.message).toBe('Temperature 92°C')
      expect(manager.getAlert(updated.id)?.message).toBe('Temperature 92°C')
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(store.getStoredAlert(alert.id)).toBeDefined()
      expect(store.getStoredAlert(alert.id)?.message).toBe('Test alert')
    })

    it('should update store on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)

      expect(store.getStoredAlert(alert.id)?.state).toBe('acknowledged')
    })

    it('should delete from store when alert is cleared', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(manager.getAlert(alert.id)).toBeDefined()
    })
  })

  describe('stop', () => {
    it('should cancel all escalation timers on stop', async () => {
      await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'warning',
        message: 'Warning 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'warning',
        message: 'Warning 2'
      })

      expect(fakeTimers.getPendingCount()).toBe(2)

      manager.stop()

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should not emit events after stop', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      const alert2 = await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      await manager.silenceAll()

      expect(manager.getAlert(alert1.id)?.silenced).toBe(true)
      expect(manager.getAlert(alert2.id)?.silenced).toBe(true)
    })

    it('should emit silenced events for each alert', async () => {
      await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })

      expect(manager.getActiveAlertCount()).toBe(1)

      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getActiveAlertCount()).toBe(2)
    })
  })

  describe('getUnacknowledgedCount', () => {
    it('should return count of unacknowledged alerts', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'source-1',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'source-2',
        priority: 'alarm',
        message: 'Alert 2'
      })

      expect(manager.getUnacknowledgedCount()).toBe(2)

      await manager.acknowledgeAlert(alert1.id)

      expect(manager.getUnacknowledgedCount()).toBe(1)
    })
  })

  describe('unsilenceAlert', () => {
    it('should remove silenced flag from alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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

    it('should cancel silence timer and clear flags on acknowledge', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id, 5000)
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)

      await manager.acknowledgeAlert(alert.id)

      // Silence flags should be cleared immediately on acknowledge
      const acknowledged = manager.getAlert(alert.id)
      expect(acknowledged?.silenced).toBe(false)
      expect(acknowledged?.silencedUntil).toBeUndefined()

      // Advancing past silence duration should not emit unsilenced event
      events = []
      fakeTimers.advanceTime(5000)
      expect(events.filter((e) => e.type === 'unsilenced')).toHaveLength(0)
    })

    it('should clear silenced rtn-unacknowledged alert without emitting unsilenced event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Silence, then clear condition -> rtn-unacknowledged (still silenced)
      await manager.silenceAlert(alert.id, 10000)
      await manager.clearCondition(alert.id)
      expect(manager.getAlert(alert.id)?.state).toBe('rtn-unacknowledged')
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)

      // Acknowledge clears the alert entirely (rtn-unacknowledged -> cleared)
      events = []
      await manager.acknowledgeAlert(alert.id)

      // Should emit 'cleared' but NOT 'unsilenced'
      expect(events.filter((e) => e.type === 'cleared')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'unsilenced')).toHaveLength(0)
      expect(manager.getAlert(alert.id)).toBeNull()

      // Silence timer should not fire
      fakeTimers.advanceTime(10000)
      expect(events.filter((e) => e.type === 'unsilenced')).toHaveLength(0)
    })
  })

  describe('clearStaleFlag', () => {
    it('should clear stale flag on alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      const updated = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(updated.id).toBe(alert.id)
      expect(updated.priority).toBe('alarm')
    })

    it('should not allow priority reduction', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const updated = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(updated.id).toBe(alert.id)
      expect(updated.priority).toBe('alarm') // Stays at alarm
    })

    it('should cancel escalation timer when priority is escalated by source', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Escalation timer should be cancelled since priority was manually escalated
      expect(fakeTimers.getPendingCount()).toBe(0)
    })
  })

  describe('explicit escalateAlert', () => {
    it('should escalate from warning to alarm', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      const updated = await manager.escalateAlert(alert.id, 'alarm')
      expect(updated.id).toBe(alert.id)
      expect(updated.priority).toBe('alarm')
    })

    it('should reject escalation to same priority', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await expect(manager.escalateAlert(alert.id, 'alarm')).rejects.toThrow('Cannot escalate')
    })

    it('should reject de-escalation', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await expect(manager.escalateAlert(alert.id, 'warning')).rejects.toThrow('Cannot escalate')
    })

    it('should throw for non-existent alert', async () => {
      await expect(manager.escalateAlert('non-existent', 'alarm')).rejects.toThrow(
        'Alert not found'
      )
    })

    it('should cancel escalation timer on explicit escalation', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.escalateAlert(alert.id, 'alarm')

      expect(fakeTimers.getPendingCount()).toBe(0)
    })

    it('should emit escalated event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      const events: AlertEvent[] = []
      manager.on('alert', (event: AlertEvent) => events.push(event))

      await manager.escalateAlert(alert.id, 'alarm')

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('escalated')
      expect(events[0].alert.priority).toBe('alarm')
    })

    it('should reactivate acknowledged alert on escalation', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)
      const acked = manager.getAlert(alert.id)
      expect(acked?.state).toBe('acknowledged')

      const updated = await manager.escalateAlert(alert.id, 'alarm')
      expect(updated.state).toBe('unacknowledged')
      expect(updated.priority).toBe('alarm')
    })

    it('should clear silence when escalating a silenced alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })

      await manager.silenceAlert(alert.id)
      const silenced = manager.getAlert(alert.id)
      expect(silenced?.silenced).toBe(true)

      const updated = await manager.escalateAlert(alert.id, 'alarm')
      expect(updated.silenced).toBe(false)
      expect(updated.silencedUntil).toBeUndefined()
      expect(updated.priority).toBe('alarm')
    })

    it('should start escalation timer when escalating caution to warning', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'caution',
        message: 'Test alert'
      })

      // Caution does not start an escalation timer
      expect(fakeTimers.getPendingCount()).toBe(0)

      await manager.escalateAlert(alert.id, 'warning')

      // Warning should start an escalation timer
      expect(fakeTimers.getPendingCount()).toBe(1)

      // Advance time to trigger escalation to alarm
      fakeTimers.advanceTime(300 * 1000)
      expect(manager.getAlert(alert.id)?.priority).toBe('alarm')
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
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Alert is still created in memory but no events are emitted
      expect(alert).toBeDefined()
      expect(events.filter((e) => e.type === 'raised')).toHaveLength(0)
    })

    it('should handle silencing an already silenced alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
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
        path: 'stored.alert',
        $source: 'stored-source',
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
      const alert1 = createStoredAlert({
        id: 'stored-1',
        path: 'stored.alert.1',
        message: 'Alert 1'
      })
      const alert2 = createStoredAlert({
        id: 'stored-2',
        path: 'stored.alert.2',
        message: 'Alert 2'
      })
      store.prePopulate([alert1, alert2])

      await manager.loadFromStore()

      expect(manager.getActiveAlertCount()).toBe(2)
      expect(manager.getAlert('stored-1')?.message).toBe('Alert 1')
      expect(manager.getAlert('stored-2')?.message).toBe('Alert 2')
    })

    it('should rebuild alert index for duplicate detection', async () => {
      const alert = createStoredAlert({
        id: 'stored-1',
        $source: 'test-source',
        message: 'Test message'
      })
      store.prePopulate([alert])

      await manager.loadFromStore()

      // Raising an alert with the same path should update the existing one
      const updated = await manager.raiseAlert({
        path: 'stored.alert',
        $source: 'test-source',
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
        $source: 'source-123',
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
        path: 'test.alert',
        $source: 'test-source',
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

  describe('history logging', () => {
    /**
     * In-memory mock history store that records log() calls.
     */
    class MockHistoryStore implements IHistoryStore {
      entries: Omit<HistoryEntry, 'id'>[] = []
      pruneCalledWith?: number
      shouldFail = false

      initialize(): Promise<void> {
        return Promise.resolve()
      }
      close(): Promise<void> {
        return Promise.resolve()
      }
      log(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
        if (this.shouldFail) {
          return Promise.reject(new Error('History store failure'))
        }
        this.entries.push(entry)
        return Promise.resolve()
      }
      query(_query: HistoryQuery): Promise<{ entries: HistoryEntry[]; total: number }> {
        return Promise.resolve({ entries: [], total: 0 })
      }
      prune(olderThanDays: number): Promise<number> {
        this.pruneCalledWith = olderThanDays
        return Promise.resolve(0)
      }
    }

    let historyStore: MockHistoryStore
    let store: MockAlertStore

    beforeEach(() => {
      historyStore = new MockHistoryStore()
      store = new MockAlertStore()
      manager.stop()
      manager = new AlertManager(
        { ...defaultConfig, retentionDays: 90 },
        fakeTimers,
        store,
        historyStore
      )
      manager.on('alert', (event: AlertEvent) => events.push(event))
    })

    it('should log raise event', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert',
        category: 'engine'
      })

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('raise')
      expect(historyStore.entries[0].newState).toBe('unacknowledged')
      expect(historyStore.entries[0].details).toEqual({
        message: 'Test alert',
        priority: 'alarm',
        category: 'engine'
      })
    })

    it('should log acknowledge event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      historyStore.entries = []

      await manager.acknowledgeAlert(alert.id, 'user-1')

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('acknowledge')
      expect(historyStore.entries[0].userId).toBe('user-1')
      expect(historyStore.entries[0].previousState).toBe('unacknowledged')
      expect(historyStore.entries[0].newState).toBe('acknowledged')
    })

    it('should log clear event with newState cleared when RTN alert is acknowledged', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert',
        category: 'engine'
      })
      await manager.clearCondition(alert.id)
      historyStore.entries = []

      await manager.acknowledgeAlert(alert.id)

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('clear')
      expect(historyStore.entries[0].newState).toBe('normal')
      expect(historyStore.entries[0].details).toEqual({
        message: 'Test alert',
        priority: 'alarm',
        category: 'engine'
      })
    })

    it('should log silence event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      historyStore.entries = []

      await manager.silenceAlert(alert.id, 30000)

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('silence')
      expect(historyStore.entries[0].details).toHaveProperty('silencedUntil')
    })

    it('should log unsilence event', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      await manager.silenceAlert(alert.id, 30000)
      historyStore.entries = []

      await manager.unsilenceAlert(alert.id)

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('unsilence')
    })

    it('should log clear event with newState cleared on clearCondition (when alert is removed)', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert',
        category: 'engine'
      })
      await manager.acknowledgeAlert(alert.id)
      historyStore.entries = []

      await manager.clearCondition(alert.id)

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('clear')
      expect(historyStore.entries[0].newState).toBe('normal')
      expect(historyStore.entries[0].details).toEqual({
        message: 'Test alert',
        priority: 'alarm',
        category: 'engine'
      })
    })

    it('should log clear event on clearCondition (RTN transition)', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert',
        category: 'engine'
      })
      historyStore.entries = []

      await manager.clearCondition(alert.id)

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('clear')
      expect(historyStore.entries[0].newState).toBe('rtn-unacknowledged')
      expect(historyStore.entries[0].details).toEqual({
        message: 'Test alert',
        priority: 'alarm',
        category: 'engine'
      })
    })

    it('should log escalate event', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })
      historyStore.entries = []

      fakeTimers.advanceTime(300 * 1000)

      // Give fire-and-forget a chance to resolve
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('escalate')
      expect(historyStore.entries[0].previousPriority).toBe('warning')
      expect(historyStore.entries[0].newPriority).toBe('alarm')
    })

    it('should log unsilence event on silence expiration', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      await manager.silenceAlert(alert.id, 5000)
      historyStore.entries = []

      fakeTimers.advanceTime(5000)

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(historyStore.entries).toHaveLength(1)
      expect(historyStore.entries[0].eventType).toBe('unsilence')
    })

    it('should log silence events for each alert in silenceAll', async () => {
      await manager.raiseAlert({
        path: 'test.alert.1',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Alert 1'
      })
      await manager.raiseAlert({
        path: 'test.alert.2',
        $source: 'test-source',
        priority: 'warning',
        message: 'Alert 2'
      })
      historyStore.entries = []

      await manager.silenceAll()

      const silenceEntries = historyStore.entries.filter((e) => e.eventType === 'silence')
      expect(silenceEntries).toHaveLength(2)
      expect(silenceEntries.every((e) => e.details?.silencedUntil)).toBe(true)
    })

    it('should log escalate event when re-raising with higher priority', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test alert'
      })
      historyStore.entries = []

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      const escalateEntries = historyStore.entries.filter((e) => e.eventType === 'escalate')
      expect(escalateEntries).toHaveLength(1)
      expect(escalateEntries[0].previousPriority).toBe('warning')
      expect(escalateEntries[0].newPriority).toBe('alarm')
    })

    it('should log unsilence event for expired silence on loadFromStore', async () => {
      // Seed a silenced alert with expired silencedUntil directly into the store
      const silencedAlert: Alert = {
        id: 'expired-silence-1',
        path: 'test.expired.silence',
        $source: 'test-source',
        priority: 'alarm',
        state: 'unacknowledged',
        condition: true,
        latching: false,
        silenced: true,
        silencedUntil: new Date(Date.now() - 1000).toISOString(),
        message: 'Test alert',
        raisedAt: new Date(Date.now() - 60000).toISOString(),
        sourceOnline: true,
        lastSourceUpdate: new Date().toISOString(),
        stale: false
      }
      await store.save(silencedAlert)

      // Create a new manager and load from store
      const newHistoryStore = new MockHistoryStore()
      const newManager = new AlertManager(
        { ...defaultConfig, retentionDays: 90 },
        fakeTimers,
        store,
        newHistoryStore
      )
      await newManager.loadFromStore()

      const unsilenceEntries = newHistoryStore.entries.filter((e) => e.eventType === 'unsilence')
      expect(unsilenceEntries).toHaveLength(1)
      newManager.stop()
    })

    it('should not affect alert operations when history logging fails', async () => {
      historyStore.shouldFail = true

      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Alert should still be created despite history failure
      expect(manager.getAlert(alert.id)).toBeDefined()
    })

    it('should prune history on loadFromStore', async () => {
      await manager.loadFromStore()

      // Give fire-and-forget a chance to resolve
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(historyStore.pruneCalledWith).toBe(90)
    })

    it('should work without history store (no errors)', async () => {
      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, store)
      manager.on('alert', (event: AlertEvent) => events.push(event))

      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      expect(manager.getAlert(alert.id)).toBeDefined()
    })
  })

  describe('re-raise reactivation', () => {
    it('should reactivate acknowledged alert to unacknowledged on re-raise', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id, 'user-1')
      expect(manager.getAlert(alert.id)?.state).toBe('acknowledged')

      const reraised = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      expect(reraised.id).toBe(alert.id)
      expect(reraised.state).toBe('unacknowledged')
      expect(reraised.acknowledgedAt).toBeUndefined()
      expect(reraised.acknowledgedBy).toBeUndefined()
    })

    it('should reactivate rtn-unacknowledged alert to unacknowledged on re-raise', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.clearCondition(alert.id)
      expect(manager.getAlert(alert.id)?.state).toBe('rtn-unacknowledged')

      const reraised = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      expect(reraised.id).toBe(alert.id)
      expect(reraised.state).toBe('unacknowledged')
      expect(reraised.clearedAt).toBeUndefined()
    })

    it('should emit raised event on reactivation (not updated)', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)
      events = []

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('raised')
      expect(events[0].previousState).toBe('acknowledged')
    })

    it('should emit updated event for unacknowledged re-raise (no state change)', async () => {
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      events = []

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert updated'
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('updated')
    })

    it('should restart escalation timer for reactivated warning', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test warning'
      })

      expect(fakeTimers.getPendingCount()).toBe(1)

      await manager.acknowledgeAlert(alert.id)
      expect(fakeTimers.getPendingCount()).toBe(0)

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'warning',
        message: 'Test warning re-raised'
      })

      // Escalation timer should be restarted
      expect(fakeTimers.getPendingCount()).toBe(1)

      // Verify it fires
      fakeTimers.advanceTime(300 * 1000)
      expect(manager.getAlert(alert.id)?.priority).toBe('alarm')
    })

    it('should un-silence and cancel silence timer on re-raise', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      await manager.acknowledgeAlert(alert.id)
      // Silence the acknowledged alert
      await manager.silenceAlert(alert.id, 30000)
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      const reactivated = manager.getAlert(alert.id)
      expect(reactivated?.silenced).toBe(false)
      expect(reactivated?.silencedUntil).toBeUndefined()

      // Silence timer should not fire (was cancelled)
      events = []
      fakeTimers.advanceTime(30000)
      expect(events.filter((e) => e.type === 'unsilenced')).toHaveLength(0)
    })

    it('should un-silence on idempotent re-raise of unacknowledged alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })

      // Silence without acknowledging first
      await manager.silenceAlert(alert.id, 30000)
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)
      expect(manager.getAlert(alert.id)?.state).toBe('unacknowledged')

      // Re-raise the same alert (idempotent reactivation)
      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      const reactivated = manager.getAlert(alert.id)
      expect(reactivated?.state).toBe('unacknowledged')
      expect(reactivated?.silenced).toBe(false)
      expect(reactivated?.silencedUntil).toBeUndefined()

      // Silence timer should not fire (was cancelled)
      events = []
      fakeTimers.advanceTime(30000)
      expect(events.filter((e) => e.type === 'unsilenced')).toHaveLength(0)
    })

    it('should preserve raisedAt on reactivation', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      const originalRaisedAt = alert.raisedAt

      await manager.acknowledgeAlert(alert.id)

      const reraised = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      expect(reraised.raisedAt).toBe(originalRaisedAt)
    })

    it('should log raise history event on reactivation', async () => {
      const historyEntries: { eventType: string; previousState?: string; newState?: string }[] = []
      const mockHistoryStore = {
        initialize: () => Promise.resolve(),
        close: () => Promise.resolve(),
        log: (entry: { eventType: string; previousState?: string; newState?: string }) => {
          historyEntries.push(entry)
          return Promise.resolve()
        },
        query: () => Promise.resolve({ entries: [], total: 0 }),
        prune: () => Promise.resolve(0)
      } as unknown as import('../../src/types.js').IHistoryStore

      manager.stop()
      manager = new AlertManager(defaultConfig, fakeTimers, undefined, mockHistoryStore)
      manager.on('alert', (event: AlertEvent) => events.push(event))

      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert'
      })
      await manager.acknowledgeAlert(alert.id)
      historyEntries.length = 0

      await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test-source',
        priority: 'alarm',
        message: 'Test alert re-raised'
      })

      const raiseEntries = historyEntries.filter((e) => e.eventType === 'raise')
      expect(raiseEntries).toHaveLength(1)
      expect(raiseEntries[0].previousState).toBe('acknowledged')
      expect(raiseEntries[0].newState).toBe('unacknowledged')
    })
  })
})
