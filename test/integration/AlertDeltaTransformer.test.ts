import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Delta, DeltaInputHandler } from '@signalk/server-api'
import { AlertDeltaTransformer } from '../../src/integration/AlertDeltaTransformer.js'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import { createTestDelta } from '../../src/test/MockServerAPI.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'

const defaultConfig: AlertManagerConfig = {
  escalation: { enabled: true, timeoutSeconds: 300 },
  silencing: { defaultMaxSilenceSeconds: 120, emergencyMaxSilenceSeconds: 30 },
  sourceTimeout: { markStaleAfterSeconds: 60 }
}

describe('AlertDeltaTransformer', () => {
  let alertManager: AlertManager
  let fakeTimers: FakeTimerFunctions
  let registeredHandler: DeltaInputHandler | undefined
  let transformer: AlertDeltaTransformer

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
    alertManager = new AlertManager(defaultConfig, fakeTimers)
    registeredHandler = undefined

    transformer = new AlertDeltaTransformer({
      alertManager,
      registerDeltaInputHandler: (handler: DeltaInputHandler) => {
        registeredHandler = handler
      },
      debug: () => undefined
    })
    transformer.start()
  })

  afterEach(() => {
    transformer.stop()
    alertManager.stop()
  })

  function pushDelta(delta: Delta): Delta | undefined {
    if (!registeredHandler) {
      throw new Error('No handler registered')
    }
    let passedDelta: Delta | undefined
    registeredHandler(delta, (d: Delta) => {
      passedDelta = d
    })
    return passedDelta
  }

  it('should always pass through deltas', () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })
    const passed = pushDelta(delta)
    expect(passed).toBe(delta)
  })

  it('should create alert from alerts.* delta', async () => {
    const delta = createTestDelta({
      updates: [
        {
          $source: 'sensESP',
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const alerts = alertManager.getAlerts()
    expect(alerts[0].priority).toBe('alarm')
    expect(alerts[0].path).toBe('engine.overheating')
    expect(alerts[0].$source).toBe('sensESP')
    expect(alerts[0].message).toBe('Engine overheating')
  })

  it('should extract optional fields (group, data, latching)', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.coolant',
              value: {
                priority: 'alarm',
                message: 'Coolant temp high',
                group: 'engine',
                data: { value: 95, threshold: 90 },
                latching: true
              }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const alert = alertManager.getAlerts()[0]
    expect(alert.group).toBe('engine')
    expect(alert.data).toEqual({ value: 95, threshold: 90 })
    expect(alert.latching).toBe(true)
  })

  it('should ignore lifecycle fields from delta (id, state, silenced)', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: {
                id: 'fake-id',
                priority: 'alarm',
                message: 'Engine overheating',
                state: 'acknowledged',
                silenced: true
              }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const alert = alertManager.getAlerts()[0]
    expect(alert.id).not.toBe('fake-id')
    expect(alert.state).toBe('unacknowledged')
    expect(alert.silenced).toBe(false)
  })

  it('should clear alert on state: normal', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.sensor.temperature',
              value: { priority: 'caution', message: 'Temp rising' }
            }
          ]
        }
      ]
    })

    pushDelta(raiseDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.sensor.temperature',
              value: { state: 'normal' }
            }
          ]
        }
      ]
    })

    pushDelta(clearDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(0)
    })
  })

  it('should clear alert on null value', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.sensor.temperature',
              value: { priority: 'caution', message: 'Temp rising' }
            }
          ]
        }
      ]
    })

    pushDelta(raiseDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [{ path: 'alerts.sensor.temperature', value: null }]
        }
      ]
    })

    pushDelta(clearDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(0)
    })
  })

  it('should move unacknowledged alert to rtn-unacknowledged on clear', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(raiseDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [{ path: 'alerts.engine.overheating', value: { state: 'normal' } }]
        }
      ]
    })

    pushDelta(clearDelta)
    await vi.waitFor(() => {
      const alerts = alertManager.getAlerts()
      expect(alerts[0].state).toBe('rtn-unacknowledged')
    })
  })

  it('should skip own deltas from alert-manager source', async () => {
    const delta = createTestDelta({
      updates: [
        {
          source: { label: 'alert-manager' },
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should ignore non-alerts.* paths', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [{ path: 'navigation.position', value: { latitude: 60, longitude: 25 } }]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should ignore deltas with missing priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should ignore deltas with invalid priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'critical', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should ignore deltas with missing message', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should escalate priority when source publishes higher priority', async () => {
    const cautionDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.nav.waypoint',
              value: { priority: 'caution', message: 'Approaching waypoint' }
            }
          ]
        }
      ]
    })

    pushDelta(cautionDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })
    expect(alertManager.getAlerts()[0].priority).toBe('caution')

    const alarmDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.nav.waypoint',
              value: { priority: 'alarm', message: 'Waypoint overshoot' }
            }
          ]
        }
      ]
    })

    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getAlerts()[0].priority).toBe('alarm')
    })
    expect(alertManager.getActiveAlertCount()).toBe(1)
  })

  it('should heartbeat for repeated identical deltas', async () => {
    const heartbeatSpy = vi.spyOn(alertManager, 'sourceHeartbeat')

    const delta = createTestDelta({
      updates: [
        {
          $source: 'sensESP',
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))

    expect(heartbeatSpy).toHaveBeenCalledWith('sensESP')
  })

  it('should not process deltas after stop()', async () => {
    transformer.stop()

    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: { priority: 'alarm', message: 'Engine overheating' }
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })

  it('should clean up pathToAlertId when alert is cleared externally', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.sensor.temp',
              value: { priority: 'caution', message: 'Temp rising' }
            }
          ]
        }
      ]
    })

    pushDelta(raiseDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const alertId = alertManager.getAlerts()[0].id
    await alertManager.clearCondition(alertId)

    // Clear delta for already-cleared alert should be a no-op
    const clearDelta = createTestDelta({
      updates: [
        {
          values: [{ path: 'alerts.sensor.temp', value: { state: 'normal' } }]
        }
      ]
    })
    pushDelta(clearDelta)
    await new Promise((r) => setTimeout(r, 10))
    // Should not throw
  })

  it('should ignore deltas with primitive (non-object) values', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'alerts.engine.overheating',
              value: 42
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))
    expect(alertManager.getActiveAlertCount()).toBe(0)
  })
})
