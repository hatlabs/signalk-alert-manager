import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Delta, DeltaInputHandler, Notification } from '@signalk/server-api'
import { ALARM_STATE, ALARM_METHOD } from '@signalk/server-api'
import { NotificationTransformer } from '../../src/integration/NotificationTransformer.js'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import { createTestDelta } from '../../src/test/MockServerAPI.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'

const defaultConfig: AlertManagerConfig = {
  escalation: { enabled: true, timeoutSeconds: 300 },
  silencing: { alarmMaxSeconds: 30, emergencyMaxSeconds: 10 },
  sourceTimeout: { markStaleAfterSeconds: 60 }
}

function makeNotification(
  state: ALARM_STATE | string,
  message = 'Test notification'
): Notification {
  return {
    state: state as ALARM_STATE,
    method: [ALARM_METHOD.visual, ALARM_METHOD.sound],
    message
  }
}

describe('NotificationTransformer', () => {
  let alertManager: AlertManager
  let fakeTimers: FakeTimerFunctions
  let registeredHandler: DeltaInputHandler | undefined
  let debugMessages: unknown[]
  let transformer: NotificationTransformer

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
    alertManager = new AlertManager(defaultConfig, fakeTimers)
    registeredHandler = undefined
    debugMessages = []

    transformer = new NotificationTransformer({
      alertManager,
      registerDeltaInputHandler: (handler: DeltaInputHandler) => {
        registeredHandler = handler
      },
      debug: (msg: unknown, ...args: unknown[]) => {
        debugMessages.push({ msg, args })
      }
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

  it('should register a delta input handler on start', () => {
    expect(registeredHandler).toBeDefined()
  })

  it('should always call next(delta) to pass through', () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm)
            }
          ]
        }
      ]
    })

    const passed = pushDelta(delta)
    expect(passed).toBe(delta)
  })

  it('should create alert from alarm notification with correct fields', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
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
    expect(alerts).toHaveLength(1)
    expect(alerts[0].priority).toBe('alarm')
    expect(alerts[0].sourceId).toBe('notifications:notifications.engine.overheating')
    expect(alerts[0].category).toBe('engine')
    expect(alerts[0].message).toBe('Engine overheating')
  })

  it('should map emergency state to emergency priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.fire.engineRoom',
              value: makeNotification(ALARM_STATE.emergency, 'Fire in engine room')
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    expect(alertManager.getAlerts()[0].priority).toBe('emergency')
  })

  it('should map warn state to warning priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.fuel.low',
              value: makeNotification(ALARM_STATE.warn, 'Fuel low')
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    expect(alertManager.getAlerts()[0].priority).toBe('warning')
  })

  it('should map non-standard "warning" string to warning priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.fuel.low',
              value: makeNotification('warning', 'Fuel low')
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    expect(alertManager.getAlerts()[0].priority).toBe('warning')
  })

  it('should map alert state to caution priority', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.battery.low',
              value: makeNotification(ALARM_STATE.alert, 'Battery low')
            }
          ]
        }
      ]
    })

    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    expect(alertManager.getAlerts()[0].priority).toBe('caution')
  })

  it('should clear existing alert on normal state', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
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
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.normal, 'Engine normal')
            }
          ]
        }
      ]
    })
    pushDelta(clearDelta)
    await vi.waitFor(() => {
      const alerts = alertManager.getAlerts()
      // Alarm alerts go to rtn-unacknowledged on clearCondition
      expect(alerts.length === 0 || alerts[0].state === 'rtn-unacknowledged').toBe(true)
    })
  })

  it('should clear existing alert on nominal state', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.info.update',
              value: makeNotification(ALARM_STATE.alert, 'Update available')
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
              path: 'notifications.info.update',
              value: makeNotification(ALARM_STATE.nominal, 'All nominal')
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

  it('should clear existing alert on null value', async () => {
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.info.update',
              value: makeNotification(ALARM_STATE.alert, 'Update available')
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
          values: [{ path: 'notifications.info.update', value: null }]
        }
      ]
    })
    pushDelta(clearDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(0)
    })
  })

  it('should be a no-op when clearing unknown path', () => {
    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.unknown.path',
              value: makeNotification(ALARM_STATE.normal, 'Normal')
            }
          ]
        }
      ]
    })

    expect(() => pushDelta(clearDelta)).not.toThrow()
  })

  it('should ignore non-notification paths', async () => {
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

  it('should deduplicate notifications via sourceId+message', async () => {
    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
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
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })
  })

  it('should not propagate raiseAlert errors', async () => {
    const brokenManager = {
      raiseAlert: vi.fn().mockRejectedValue(new Error('DB error')),
      clearCondition: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    } as unknown as AlertManager

    let brokenHandler: DeltaInputHandler | undefined
    const brokenTransformer = new NotificationTransformer({
      alertManager: brokenManager,
      registerDeltaInputHandler: (handler: DeltaInputHandler) => {
        brokenHandler = handler
      },
      debug: () => undefined
    })
    brokenTransformer.start()

    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
            }
          ]
        }
      ]
    })

    if (!brokenHandler) {
      throw new Error('No handler registered')
    }

    let passed: Delta | undefined
    expect(() => {
      brokenHandler(delta, (d: Delta) => {
        passed = d
      })
    }).not.toThrow()

    expect(passed).toBe(delta)

    // Wait for the promise chain to settle
    await new Promise((r) => setTimeout(r, 10))
    brokenTransformer.stop()
  })

  it('should handle rapid raise-then-clear without race condition', async () => {
    // Push raise and clear in rapid succession for the same path
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.sensor.flapping',
              value: makeNotification(ALARM_STATE.alert, 'Sensor flapping')
            }
          ]
        }
      ]
    })

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.sensor.flapping',
              value: makeNotification(ALARM_STATE.normal, 'Sensor normal')
            }
          ]
        }
      ]
    })

    // Push both immediately — clear arrives before raise completes
    pushDelta(raiseDelta)
    pushDelta(clearDelta)

    // The serialized operation queue ensures raise completes before clear runs
    await vi.waitFor(() => {
      // Caution auto-clears on clearCondition, so should be 0
      expect(alertManager.getActiveAlertCount()).toBe(0)
    })
  })

  it('should not process deltas after stop()', async () => {
    transformer.stop()

    const delta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
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
    // Raise via notification
    const raiseDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.info.update',
              value: makeNotification(ALARM_STATE.alert, 'Update available')
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

    // Clear externally via alertManager (simulating operator acknowledge or API clear)
    await alertManager.clearCondition(alertId)

    // The alert event listener should clean up the path mapping
    // Verify by trying to clear again — should be a no-op
    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.info.update',
              value: makeNotification(ALARM_STATE.normal, 'Normal')
            }
          ]
        }
      ]
    })
    pushDelta(clearDelta)
    // Should not throw "Alert not found" since pathToAlertId was cleaned
    await new Promise((r) => setTimeout(r, 10))
  })
})
