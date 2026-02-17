/**
 * E2E Notification Tests
 *
 * Tests the Signal K notification -> alert transformation flow.
 * Sends SK notification deltas to the server and verifies they are
 * converted to alerts with correct priority mappings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, type TestServer } from './helpers/server.js'
import { AlertClient } from './helpers/client.js'
import type { Alert } from '../../src/types.js'

/**
 * Poll for an alert matching a predicate, with timeout.
 * Replaces fragile fixed delays for async delta processing.
 */
async function waitForAlert(
  client: AlertClient,
  predicate: (a: Alert) => boolean,
  timeoutMs = 5000
): Promise<Alert> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const alerts = await client.getAlertsJson()
    const found = alerts.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Alert not found within ${String(timeoutMs)}ms`)
}

/**
 * Poll until an alert matches a predicate (for state changes on existing alerts).
 */
async function waitForAlertState(
  client: AlertClient,
  predicate: (a: Alert) => boolean,
  timeoutMs = 5000
): Promise<Alert> {
  return waitForAlert(client, predicate, timeoutMs)
}

describe('Signal K Notification -> Alert Flow', () => {
  let server: TestServer
  let client: AlertClient

  beforeAll(async () => {
    server = await startServer()
    client = new AlertClient(server.host)
  })

  afterAll(async () => {
    await server.stop()
  })

  it('should create an alert from SK warn notification', async () => {
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.engine.overTemperature',
              value: {
                state: 'warn',
                method: ['visual', 'sound'],
                message: 'Engine coolant temperature above threshold'
              }
            }
          ]
        }
      ]
    })

    const engineAlert = await waitForAlert(
      client,
      (a) => a.message === 'Engine coolant temperature above threshold'
    )

    expect(engineAlert.priority).toBe('warning')
    expect(engineAlert.state).toBe('unacknowledged')
    expect(engineAlert.category).toBe('engine')
  })

  it('should create an alert from SK alarm notification', async () => {
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.navigation.anchorDrag',
              value: {
                state: 'alarm',
                method: ['visual', 'sound'],
                message: 'Anchor drag detected'
              }
            }
          ]
        }
      ]
    })

    const anchorAlert = await waitForAlert(client, (a) => a.message === 'Anchor drag detected')

    expect(anchorAlert.priority).toBe('alarm')
    expect(anchorAlert.category).toBe('navigation')
  })

  it('should create an alert from SK emergency notification', async () => {
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.safety.fire',
              value: {
                state: 'emergency',
                method: ['visual', 'sound'],
                message: 'Fire detected in engine room'
              }
            }
          ]
        }
      ]
    })

    const fireAlert = await waitForAlert(
      client,
      (a) => a.message === 'Fire detected in engine room'
    )

    expect(fireAlert.priority).toBe('emergency')
    expect(fireAlert.category).toBe('safety')
  })

  it('should clear alert when notification goes to normal state', async () => {
    // First raise an alert
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.electrical.lowVoltage',
              value: {
                state: 'warn',
                method: ['visual'],
                message: 'Battery voltage low'
              }
            }
          ]
        }
      ]
    })

    await waitForAlert(client, (a) => a.message === 'Battery voltage low')

    // Now send normal state to clear it
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.electrical.lowVoltage',
              value: {
                state: 'normal',
                method: [],
                message: 'Battery voltage normal'
              }
            }
          ]
        }
      ]
    })

    // Warning priority requires ack; clearCondition moves to rtn-unacknowledged
    const cleared = await waitForAlertState(
      client,
      (a) => a.message === 'Battery voltage low' && !a.condition
    )

    expect(cleared.state).toBe('rtn-unacknowledged')
    expect(cleared.condition).toBe(false)
  })

  it('should map SK alert state to caution priority', async () => {
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.tanks.fuelLow',
              value: {
                state: 'alert',
                method: ['visual'],
                message: 'Fuel level below 25%'
              }
            }
          ]
        }
      ]
    })

    const fuelAlert = await waitForAlert(client, (a) => a.message === 'Fuel level below 25%')

    expect(fuelAlert.priority).toBe('caution')
  })

  it('should clear alert when notification value is null', async () => {
    // Raise an alert
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.depth.shallow',
              value: {
                state: 'warn',
                method: ['visual', 'sound'],
                message: 'Shallow water warning'
              }
            }
          ]
        }
      ]
    })

    await waitForAlert(client, (a) => a.message === 'Shallow water warning')

    // Clear by sending null value
    await server.sendDelta({
      updates: [
        {
          values: [
            {
              path: 'notifications.depth.shallow',
              value: null
            }
          ]
        }
      ]
    })

    // Warning priority requires ack; null value triggers clearCondition -> rtn-unacknowledged
    const cleared = await waitForAlertState(
      client,
      (a) => a.message === 'Shallow water warning' && !a.condition
    )

    expect(cleared.state).toBe('rtn-unacknowledged')
    expect(cleared.condition).toBe(false)
  })
})
