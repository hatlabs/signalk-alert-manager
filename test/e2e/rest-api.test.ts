/**
 * E2E REST API Tests
 *
 * Tests all REST API endpoints for correct status codes,
 * validation errors, and filtering behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, type TestServer } from './helpers/server.js'
import { AlertClient } from './helpers/client.js'

describe('REST API Endpoints', () => {
  let server: TestServer
  let client: AlertClient

  beforeAll(async () => {
    server = await startServer()
    client = new AlertClient(server.host)
  })

  afterAll(async () => {
    await server.stop()
  })

  describe('GET /alerts', () => {
    it('should return 200 with empty array when no alerts', async () => {
      const res = await client.getAlerts()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('should return 400 for invalid state filter', async () => {
      const res = await fetch(`${server.host}/plugins/signalk-alert-manager/alerts?state=invalid`)
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid priority filter', async () => {
      const res = await fetch(
        `${server.host}/plugins/signalk-alert-manager/alerts?priority=invalid`
      )
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid stale filter', async () => {
      const res = await fetch(`${server.host}/plugins/signalk-alert-manager/alerts?stale=maybe`)
      expect(res.status).toBe(400)
    })
  })

  describe('POST /alerts', () => {
    it('should return 201 when raising a valid alert', async () => {
      const res = await client.raiseAlert({
        path: 'test.restapi.raise',
        priority: 'warning',
        message: 'REST API test alert'
      })
      expect(res.status).toBe(201)
      const alert = await res.json()
      expect(alert.id).toBeDefined()
      expect(alert.priority).toBe('warning')
    })

    it('should return 400 when priority is missing', async () => {
      const res = await fetch(`${server.host}/plugins/signalk-alert-manager/alerts`, {
        method: 'POST',
        body: JSON.stringify({ message: 'No priority' }),
        headers: { 'Content-Type': 'application/json' }
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when message is missing', async () => {
      const res = await fetch(`${server.host}/plugins/signalk-alert-manager/alerts`, {
        method: 'POST',
        body: JSON.stringify({ priority: 'warning' }),
        headers: { 'Content-Type': 'application/json' }
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when message is empty', async () => {
      const res = await client.raiseAlert({
        path: 'test.restapi.empty',
        priority: 'warning',
        message: ''
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid priority value', async () => {
      const res = await fetch(`${server.host}/plugins/signalk-alert-manager/alerts`, {
        method: 'POST',
        body: JSON.stringify({ priority: 'critical', message: 'Invalid priority' }),
        headers: { 'Content-Type': 'application/json' }
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /alerts/history', () => {
    it('should return 200 with history entries', async () => {
      const res = await client.getHistory()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('entries')
      expect(body).toHaveProperty('total')
    })

    it('should return 400 for invalid limit', async () => {
      const res = await fetch(
        `${server.host}/plugins/signalk-alert-manager/alerts/history?limit=-1`
      )
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid eventType', async () => {
      const res = await fetch(
        `${server.host}/plugins/signalk-alert-manager/alerts/history?eventType=invalid`
      )
      expect(res.status).toBe(400)
    })

    it('should return 400 for unparseable from date', async () => {
      const res = await fetch(
        `${server.host}/plugins/signalk-alert-manager/alerts/history?from=not-a-date`
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /alerts/silence-all', () => {
    it('should return 200', async () => {
      const res = await client.silenceAll()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    })
  })

  describe('GET /alerts/:id', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await client.getAlert('non-existent-id')
      expect(res.status).toBe(404)
    })

    it('should return 200 for existing alert', async () => {
      const alert = await client.raiseAlertJson({
        path: 'test.restapi.getbyid',
        priority: 'caution',
        message: 'Get by ID test'
      })

      const res = await client.getAlert(alert.id)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(alert.id)
    })
  })

  describe('POST /alerts/:id/acknowledge', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await client.acknowledgeAlert('non-existent-id')
      expect(res.status).toBe(404)
    })

    it('should return 200 for existing alert', async () => {
      const alert = await client.raiseAlertJson({
        path: 'test.restapi.ack',
        priority: 'warning',
        message: 'Ack test alert'
      })

      const res = await client.acknowledgeAlert(alert.id)
      expect(res.status).toBe(200)
    })
  })

  describe('POST /alerts/:id/silence', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await client.silenceAlert('non-existent-id')
      expect(res.status).toBe(404)
    })

    it('should return 200 for existing alert', async () => {
      const alert = await client.raiseAlertJson({
        path: 'test.restapi.silence',
        priority: 'alarm',
        message: 'Silence test alert'
      })

      const res = await client.silenceAlert(alert.id)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.silenced).toBe(true)
    })

    it('should return 400 for invalid duration', async () => {
      const alert = await client.raiseAlertJson({
        path: 'test.restapi.invalidduration',
        priority: 'alarm',
        message: 'Invalid silence duration test'
      })

      const res = await client.silenceAlert(alert.id, { duration: -5 })
      expect(res.status).toBe(400)
    })
  })

  describe('PUT /alerts/:id/condition', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await client.updateCondition('non-existent-id', { active: false })
      expect(res.status).toBe(404)
    })

    it('should return 400 when active is not a boolean', async () => {
      const alert = await client.raiseAlertJson({
        path: 'test.restapi.condition',
        priority: 'warning',
        message: 'Condition validation test'
      })

      const res = await fetch(
        `${server.host}/plugins/signalk-alert-manager/alerts/${alert.id}/condition`,
        {
          method: 'PUT',
          body: JSON.stringify({ active: 'yes' }),
          headers: { 'Content-Type': 'application/json' }
        }
      )
      expect(res.status).toBe(400)
    })
  })

  describe('Filtering', () => {
    beforeAll(async () => {
      // Clear existing alerts by acknowledging them or letting them be
      // Raise fresh alerts with known properties
      await client.raiseAlert({
        path: 'test.filter.warning',
        priority: 'warning',
        message: 'Filter test warning',
        category: 'engine'
      })
      await client.raiseAlert({
        path: 'test.filter.alarm',
        priority: 'alarm',
        message: 'Filter test alarm',
        category: 'navigation'
      })
      await client.raiseAlert({
        path: 'test.filter.caution',
        priority: 'caution',
        message: 'Filter test caution',
        category: 'engine'
      })
    })

    it('should filter by state', async () => {
      const alerts = await client.getAlertsJson({ state: 'unacknowledged' })
      expect(alerts.length).toBeGreaterThan(0)
      for (const alert of alerts) {
        expect(alert.state).toBe('unacknowledged')
      }
    })

    it('should filter by priority', async () => {
      const alerts = await client.getAlertsJson({ priority: 'alarm' })
      for (const alert of alerts) {
        expect(alert.priority).toBe('alarm')
      }
    })

    it('should filter by category', async () => {
      const alerts = await client.getAlertsJson({ category: 'engine' })
      for (const alert of alerts) {
        expect(alert.category).toBe('engine')
      }
    })

    it('should combine multiple filters', async () => {
      const alerts = await client.getAlertsJson({
        priority: 'warning',
        category: 'engine'
      })
      for (const alert of alerts) {
        expect(alert.priority).toBe('warning')
        expect(alert.category).toBe('engine')
      }
    })
  })
})
