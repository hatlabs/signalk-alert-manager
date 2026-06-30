import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Delta, DeltaInputHandler, Notification } from '@signalk/server-api'
import { ALARM_STATE, ALARM_METHOD } from '@signalk/server-api'
import { NotificationTransformer } from '../../src/integration/NotificationTransformer.js'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import { createTestDelta } from '../../src/test/MockServerAPI.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'

const defaultConfig: AlertManagerConfig = {
  escalation: { enabled: true, timeoutSeconds: 300 },
  silencing: { defaultMaxSilenceSeconds: 120, emergencyMaxSilenceSeconds: 30 },
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
    expect(alerts[0].path).toBe('engine.overheating')
    expect(alerts[0].$source).toBe('notifications')
    expect(alerts[0].group).toBe('engine')
    expect(alerts[0].message).toBe('Engine overheating')
  })

  it('should pass through $source from delta update', async () => {
    const delta = createTestDelta({
      updates: [
        {
          $source: 'n2k-on-ve.can-bus.115',
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

    expect(alertManager.getAlerts()[0].$source).toBe('n2k-on-ve.can-bus.115')
  })

  it('should pass through source object from delta update', async () => {
    const sourceObj = {
      type: 'NMEA2000',
      pgn: 127489,
      label: 'N2K device',
      src: '115'
    }
    const delta = createTestDelta({
      updates: [
        {
          $source: 'n2k-on-ve.can-bus.115',
          source: sourceObj,
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

    expect(alertManager.getAlerts()[0].source).toEqual(sourceObj)
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

  it('should deduplicate notifications via path', async () => {
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

  it('should not call raiseAlert redundantly for repeated alarm deltas', async () => {
    const raiseAlertSpy = vi.spyOn(alertManager, 'raiseAlert')

    const delta = createTestDelta({
      updates: [
        {
          $source: 'n2k-on-ve.can-bus.115',
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
            }
          ]
        }
      ]
    })

    // First delta → should call raiseAlert
    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    // Second and third deltas → should NOT call raiseAlert again
    pushDelta(delta)
    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))

    expect(raiseAlertSpy).toHaveBeenCalledTimes(1)
  })

  it('should call raiseAlert again after alarm → clear → alarm cycle', async () => {
    const raiseAlertSpy = vi.spyOn(alertManager, 'raiseAlert')

    const alarmDelta = createTestDelta({
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

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.normal, 'Normal')
            }
          ]
        }
      ]
    })

    // First alarm
    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    // Clear
    pushDelta(clearDelta)
    await vi.waitFor(() => {
      const alerts = alertManager.getAlerts()
      expect(alerts.length === 0 || alerts[0].state === 'rtn-unacknowledged').toBe(true)
    })

    // Second alarm → should call raiseAlert again (reactivation)
    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      const alerts = alertManager.getAlerts()
      expect(alerts.some((a) => a.state === 'unacknowledged')).toBe(true)
    })

    expect(raiseAlertSpy).toHaveBeenCalledTimes(2)
  })

  it('should reactivate acknowledged alert after clear → alarm cycle', async () => {
    const alarmDelta = createTestDelta({
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

    const clearDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.normal, 'Normal')
            }
          ]
        }
      ]
    })

    // 1. Alarm delta → raises alert
    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })
    const alertId = alertManager.getAlerts()[0].id
    expect(alertManager.getAlerts()[0].state).toBe('unacknowledged')

    // 2. Acknowledge the alert
    await alertManager.acknowledgeAlert(alertId)
    expect(alertManager.getAlert(alertId)?.state).toBe('acknowledged')

    // 3. Clear delta → clears acknowledged alert (acknowledged + clearCondition = cleared)
    pushDelta(clearDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(0)
    })

    // 4. Alarm delta again → should re-raise as new unacknowledged alert
    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    const reactivated = alertManager.getAlerts()[0]
    expect(reactivated.state).toBe('unacknowledged')
    expect(reactivated.path).toBe('engine.overheating')
  })

  it('should update source liveness via heartbeat for repeated deltas', async () => {
    const heartbeatSpy = vi.spyOn(alertManager, 'sourceHeartbeat')

    const delta = createTestDelta({
      updates: [
        {
          $source: 'n2k-on-ve.can-bus.115',
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Engine overheating')
            }
          ]
        }
      ]
    })

    // First → raiseAlert
    pushDelta(delta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })

    // Second → should heartbeat instead
    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))

    expect(heartbeatSpy).toHaveBeenCalledWith('n2k-on-ve.can-bus.115')
  })

  it('should escalate priority when source publishes higher state', async () => {
    const cautionDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.nav.waypoint',
              value: makeNotification(ALARM_STATE.alert, 'Approaching waypoint')
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
              path: 'notifications.nav.waypoint',
              value: makeNotification(ALARM_STATE.alarm, 'Waypoint overshoot')
            }
          ]
        }
      ]
    })

    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getAlerts()[0].priority).toBe('alarm')
    })

    // Should still be the same alert (updated, not duplicated)
    expect(alertManager.getActiveAlertCount()).toBe(1)
  })

  it('should update message when source publishes new message at same priority', async () => {
    const delta1 = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Temperature rising')
            }
          ]
        }
      ]
    })

    pushDelta(delta1)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })
    expect(alertManager.getAlerts()[0].message).toBe('Temperature rising')

    const delta2 = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alarm, 'Temperature critical')
            }
          ]
        }
      ]
    })

    pushDelta(delta2)
    await vi.waitFor(() => {
      expect(alertManager.getAlerts()[0].message).toBe('Temperature critical')
    })
    expect(alertManager.getActiveAlertCount()).toBe(1)
  })

  it('should not de-escalate when source publishes lower state', async () => {
    const alarmDelta = createTestDelta({
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

    pushDelta(alarmDelta)
    await vi.waitFor(() => {
      expect(alertManager.getActiveAlertCount()).toBe(1)
    })
    expect(alertManager.getAlerts()[0].priority).toBe('alarm')

    const cautionDelta = createTestDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overheating',
              value: makeNotification(ALARM_STATE.alert, 'Engine overheating')
            }
          ]
        }
      ]
    })

    pushDelta(cautionDelta)
    await new Promise((r) => setTimeout(r, 10))

    // Priority should remain at alarm — AlertManager blocks de-escalation
    expect(alertManager.getAlerts()[0].priority).toBe('alarm')
    expect(alertManager.getActiveAlertCount()).toBe(1)
  })

  it('should not re-raise when priority and message are unchanged', async () => {
    const raiseAlertSpy = vi.spyOn(alertManager, 'raiseAlert')

    const delta = createTestDelta({
      updates: [
        {
          $source: 'sensor-1',
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

    // Same priority and message → should heartbeat, not re-raise
    pushDelta(delta)
    await new Promise((r) => setTimeout(r, 10))

    expect(raiseAlertSpy).toHaveBeenCalledTimes(1)
  })
})
