/**
 * E2E Lifecycle Tests
 *
 * Tests the full alert lifecycle through a real Signal K server instance:
 * raise -> acknowledge -> clear, and latching alert flows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, type TestServer } from './helpers/server.js'
import { AlertClient } from './helpers/client.js'

describe('Alert Lifecycle', () => {
  let server: TestServer
  let client: AlertClient

  beforeAll(async () => {
    server = await startServer()
    client = new AlertClient(server.host)
  })

  afterAll(async () => {
    await server.stop()
  })

  describe('Non-latching alert: raise -> acknowledge -> clear', () => {
    let alertId: string

    it('should raise an alert in unacknowledged state', async () => {
      const alert = await client.raiseAlertJson({
        priority: 'warning',
        message: 'Test lifecycle alert',
        category: 'test'
      })

      expect(alert.id).toBeDefined()
      expect(alert.state).toBe('unacknowledged')
      expect(alert.priority).toBe('warning')
      expect(alert.condition).toBe(true)
      expect(alert.message).toBe('Test lifecycle alert')
      alertId = alert.id
    })

    it('should transition to acknowledged on ack', async () => {
      const result = await client.acknowledgeAlertJson(alertId)

      expect(result.previousState).toBe('unacknowledged')
      expect(result.cleared).toBe(false)
      expect(result.alert).not.toBeNull()
      expect(result.alert?.state).toBe('acknowledged')
    })

    it('should clear when condition is removed after acknowledgment', async () => {
      const result = await client.updateConditionJson(alertId, { active: false })

      expect(result.previousState).toBe('acknowledged')
      expect(result.cleared).toBe(true)
    })

    it('should no longer appear in alert list', async () => {
      const alerts = await client.getAlertsJson()
      const found = alerts.find((a) => a.id === alertId)
      expect(found).toBeUndefined()
    })
  })

  describe('Non-latching alert: clear condition before ack -> rtn-unacknowledged -> ack -> clear', () => {
    let alertId: string

    it('should raise an alert', async () => {
      const alert = await client.raiseAlertJson({
        priority: 'alarm',
        message: 'Transient alarm'
      })
      alertId = alert.id
      expect(alert.state).toBe('unacknowledged')
    })

    it('should transition to rtn-unacknowledged when condition clears', async () => {
      const result = await client.updateConditionJson(alertId, { active: false })

      // Non-latching, ack-required: unacknowledged -> rtn-unacknowledged
      expect(result.cleared).toBe(false)
      expect(result.alert).not.toBeNull()
      expect(result.alert?.state).toBe('rtn-unacknowledged')
      expect(result.alert?.condition).toBe(false)
    })

    it('should clear when acknowledged in rtn-unacknowledged state', async () => {
      const result = await client.acknowledgeAlertJson(alertId)

      expect(result.previousState).toBe('rtn-unacknowledged')
      expect(result.cleared).toBe(true)
    })
  })

  describe('Caution alert: auto-clears on condition clear', () => {
    let alertId: string

    it('should raise a caution alert', async () => {
      const alert = await client.raiseAlertJson({
        priority: 'caution',
        message: 'Auto-clear caution'
      })
      alertId = alert.id
      expect(alert.state).toBe('unacknowledged')
    })

    it('should auto-clear when condition is removed', async () => {
      const result = await client.updateConditionJson(alertId, { active: false })

      // Caution priority doesn't require ack, so it clears directly
      expect(result.cleared).toBe(true)
    })
  })

  describe('Latching alert: condition clear -> stays unacked -> ack -> clear', () => {
    let alertId: string

    it('should raise a latching alert', async () => {
      const alert = await client.raiseAlertJson({
        priority: 'warning',
        message: 'Latching test alert',
        category: 'engine',
        latching: true
      })
      alertId = alert.id
      expect(alert.state).toBe('unacknowledged')
      expect(alert.latching).toBe(true)
    })

    it('should stay unacknowledged with condition=false when condition clears', async () => {
      const result = await client.updateConditionJson(alertId, { active: false })

      // Latching alert: stays in unacknowledged, condition becomes false
      expect(result.previousState).toBe('unacknowledged')
      expect(result.cleared).toBe(false)
      expect(result.alert).not.toBeNull()
      expect(result.alert?.state).toBe('unacknowledged')
      expect(result.alert?.condition).toBe(false)
    })

    it('should clear when acknowledged with condition cleared', async () => {
      const result = await client.acknowledgeAlertJson(alertId)

      // Latching + unacknowledged + condition=false -> cleared on ack
      expect(result.previousState).toBe('unacknowledged')
      expect(result.cleared).toBe(true)
    })

    it('should no longer appear in alert list', async () => {
      const alerts = await client.getAlertsJson()
      const found = alerts.find((a) => a.id === alertId)
      expect(found).toBeUndefined()
    })
  })
})
