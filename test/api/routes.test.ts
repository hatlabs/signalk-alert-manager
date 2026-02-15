/**
 * REST API Routes Tests
 *
 * Tests for all REST endpoints defined in issue #16.
 * Uses a real AlertManager with in-memory stores and an Express router.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express, { type Express } from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import type { IHistoryStore, HistoryEntry, HistoryQuery, Alert } from '../../src/types.js'
import { registerRoutes, type RouteDependencies } from '../../src/api/routes.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AlertManagerConfig = {
  escalation: { enabled: false, timeoutSeconds: 300 },
  silencing: { alarmMaxSeconds: 30, emergencyMaxSeconds: 10 },
  sourceTimeout: { markStaleAfterSeconds: 60 },
  retentionDays: 90
}

class MockHistoryStore implements IHistoryStore {
  entries: HistoryEntry[] = []
  initialized = false

  initialize(): Promise<void> {
    this.initialized = true
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.initialized = false
    return Promise.resolve()
  }
  log(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    this.entries.push({ ...entry, id: crypto.randomUUID() } as HistoryEntry)
    return Promise.resolve()
  }
  query(query: HistoryQuery): Promise<{ entries: HistoryEntry[]; total: number }> {
    let results = [...this.entries]

    if (query.alertId) {
      results = results.filter((e) => e.alertId === query.alertId)
    }
    if (query.eventType) {
      const types = Array.isArray(query.eventType) ? query.eventType : [query.eventType]
      results = results.filter((e) => types.includes(e.eventType))
    }
    if (query.from) {
      const from = query.from
      results = results.filter((e) => e.timestamp >= from)
    }
    if (query.to) {
      const to = query.to
      results = results.filter((e) => e.timestamp <= to)
    }

    const total = results.length

    if (query.limit !== undefined) {
      const offset = query.offset ?? 0
      results = results.slice(offset, offset + query.limit)
    }

    return Promise.resolve({ entries: results, total })
  }
  prune(): Promise<number> {
    return Promise.resolve(0)
  }
}

interface TestContext {
  app: Express
  server: http.Server
  baseUrl: string
  manager: AlertManager
  historyStore: MockHistoryStore
}

function createTestContext(): TestContext {
  const manager = new AlertManager(DEFAULT_CONFIG)
  const historyStore = new MockHistoryStore()

  const app = express()
  app.use(express.json())

  const deps: RouteDependencies = {
    getAlertManager: () => manager,
    getHistoryStore: () => historyStore
  }
  registerRoutes(app, deps)

  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${String(port)}`

  return { app, server, baseUrl, manager, historyStore }
}

async function raiseTestAlert(
  ctx: TestContext,
  overrides?: Partial<{
    priority: string
    message: string
    category: string
    latching: boolean
    sourceId: string
    data: Record<string, unknown>
  }>
): Promise<Alert> {
  return ctx.manager.raiseAlert({
    sourceId: overrides?.sourceId ?? 'test-source',
    priority: (overrides?.priority ?? 'alarm') as Alert['priority'],
    message: overrides?.message ?? 'Test alert',
    category: overrides?.category,
    data: overrides?.data,
    latching: overrides?.latching ?? false
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REST API Routes', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  afterEach(() => {
    ctx.manager.stop()
    ctx.server.close()
  })

  // =========================================================================
  // GET /alerts
  // =========================================================================

  describe('GET /alerts', () => {
    it('should return empty array when no alerts', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('should return all alerts', async () => {
      await raiseTestAlert(ctx, { message: 'Alert 1' })
      await raiseTestAlert(ctx, { message: 'Alert 2' })

      const res = await fetch(`${ctx.baseUrl}/alerts`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(2)
    })

    it('should filter by state', async () => {
      const alert = await raiseTestAlert(ctx)
      await ctx.manager.acknowledgeAlert(alert.id)
      await raiseTestAlert(ctx, { message: 'Unacked alert' })

      const res = await fetch(`${ctx.baseUrl}/alerts?state=unacknowledged`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(1)
      expect(body[0].state).toBe('unacknowledged')
    })

    it('should filter by multiple states', async () => {
      await raiseTestAlert(ctx, { message: 'Alert 1' })
      await raiseTestAlert(ctx, { message: 'Alert 2' })

      const res = await fetch(`${ctx.baseUrl}/alerts?state=unacknowledged,acknowledged`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(2)
    })

    it('should filter by priority', async () => {
      await raiseTestAlert(ctx, { priority: 'alarm', message: 'Alarm' })
      await raiseTestAlert(ctx, { priority: 'warning', message: 'Warning' })

      const res = await fetch(`${ctx.baseUrl}/alerts?priority=alarm`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(1)
      expect(body[0].priority).toBe('alarm')
    })

    it('should filter by multiple priorities', async () => {
      await raiseTestAlert(ctx, { priority: 'alarm', message: 'Alarm' })
      await raiseTestAlert(ctx, { priority: 'warning', message: 'Warning' })
      await raiseTestAlert(ctx, { priority: 'caution', message: 'Caution' })

      const res = await fetch(`${ctx.baseUrl}/alerts?priority=alarm,warning`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(2)
    })

    it('should filter by category', async () => {
      await raiseTestAlert(ctx, {
        category: 'engine',
        message: 'Engine alert'
      })
      await raiseTestAlert(ctx, { category: 'nav', message: 'Nav alert' })

      const res = await fetch(`${ctx.baseUrl}/alerts?category=engine`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(1)
      expect(body[0].category).toBe('engine')
    })

    it('should filter by stale', async () => {
      const alert = await raiseTestAlert(ctx)
      ctx.manager.markSourceOffline(alert.sourceId)

      const res = await fetch(`${ctx.baseUrl}/alerts?stale=true`)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(1)
      expect(body[0].stale).toBe(true)
    })
  })

  // =========================================================================
  // GET /alerts/:id
  // =========================================================================

  describe('GET /alerts/:id', () => {
    it('should return a single alert', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert
      expect(body.id).toBe(alert.id)
      expect(body.message).toBe('Test alert')
    })

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/non-existent-id`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBeDefined()
    })
  })

  // =========================================================================
  // POST /alerts
  // =========================================================================

  describe('POST /alerts', () => {
    it('should create a new alert', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priority: 'alarm',
          message: 'Engine coolant temperature high'
        })
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as Alert
      expect(body.id).toBeDefined()
      expect(body.priority).toBe('alarm')
      expect(body.message).toBe('Engine coolant temperature high')
      expect(body.sourceId).toBe('rest-api')
    })

    it('should accept optional fields', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priority: 'warning',
          message: 'Low fuel',
          category: 'engine',
          data: { level: 10 },
          latching: true
        })
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as Alert
      expect(body.category).toBe('engine')
      expect(body.data).toEqual({ level: 10 })
      expect(body.latching).toBe(true)
    })

    it('should allow custom sourceId', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priority: 'alarm',
          message: 'Custom source alert',
          sourceId: 'my-plugin'
        })
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as Alert
      expect(body.sourceId).toBe('my-plugin')
    })

    it('should return 400 when priority is missing', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No priority' })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBeDefined()
    })

    it('should return 400 when message is missing', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'alarm' })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBeDefined()
    })

    it('should return 400 for invalid priority', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priority: 'critical',
          message: 'Bad priority'
        })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBeDefined()
    })

    it('should return 400 when message exceeds max length', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priority: 'alarm',
          message: 'x'.repeat(1001)
        })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBeDefined()
    })

    it('should return 400 when message is empty string', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'alarm', message: '' })
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when message is not a string', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'alarm', message: 123 })
      })
      expect(res.status).toBe(400)
    })
  })

  // =========================================================================
  // POST /alerts/:id/acknowledge
  // =========================================================================

  describe('POST /alerts/:id/acknowledge', () => {
    it('should acknowledge an alert', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/acknowledge`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alert: Alert | null
        cleared: boolean
      }
      expect(body.cleared).toBe(false)
      expect(body.alert?.state).toBe('acknowledged')
    })

    it('should return cleared result when latched alert is acknowledged after condition clears', async () => {
      const alert = await raiseTestAlert(ctx, { latching: true })
      await ctx.manager.clearCondition(alert.id)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/acknowledge`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alert: Alert | null
        cleared: boolean
      }
      expect(body.cleared).toBe(true)
    })

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/non-existent/acknowledge`, { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })

  // =========================================================================
  // POST /alerts/:id/silence
  // =========================================================================

  describe('POST /alerts/:id/silence', () => {
    it('should silence an alert with default duration', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/silence`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert
      expect(body.silenced).toBe(true)
      expect(body.silencedUntil).toBeDefined()
    })

    it('should silence an alert with custom duration', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/silence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 60 })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert
      expect(body.silenced).toBe(true)
    })

    it('should return 400 for non-positive duration', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/silence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 0 })
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 for non-numeric duration', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/silence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 'long' })
      })
      expect(res.status).toBe(400)
    })

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/non-existent/silence`, { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })

  // =========================================================================
  // POST /alerts/silence-all
  // =========================================================================

  describe('POST /alerts/silence-all', () => {
    it('should silence all unacknowledged alerts', async () => {
      await raiseTestAlert(ctx, { message: 'Alert 1' })
      await raiseTestAlert(ctx, { message: 'Alert 2' })

      const res = await fetch(`${ctx.baseUrl}/alerts/silence-all`, {
        method: 'POST'
      })
      expect(res.status).toBe(200)

      const alerts = ctx.manager.getAlerts()
      expect(alerts.every((a) => a.silenced)).toBe(true)
    })

    it('should succeed when no alerts to silence', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/silence-all`, {
        method: 'POST'
      })
      expect(res.status).toBe(200)
    })
  })

  // =========================================================================
  // PUT /alerts/:id/condition
  // =========================================================================

  describe('PUT /alerts/:id/condition', () => {
    it('should clear condition', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/condition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alert: Alert | null
        cleared: boolean
      }
      // Alarm priority: condition clear transitions to rtn-unacknowledged
      expect(body.alert).toBeDefined()
    })

    it('should clear a caution alert entirely when condition clears', async () => {
      const alert = await raiseTestAlert(ctx, { priority: 'caution' })

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/condition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alert: Alert | null
        cleared: boolean
      }
      expect(body.cleared).toBe(true)
    })

    it('should return 400 when active field is missing', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/condition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when active is not boolean', async () => {
      const alert = await raiseTestAlert(ctx)

      const res = await fetch(`${ctx.baseUrl}/alerts/${alert.id}/condition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: 'yes' })
      })
      expect(res.status).toBe(400)
    })

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/non-existent/condition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
      expect(res.status).toBe(404)
    })
  })

  // =========================================================================
  // GET /alerts/indication
  // =========================================================================

  describe('GET /alerts/indication', () => {
    it('should return indication state with no alerts', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/indication`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.audible).toBe(false)
      expect(body.priority).toBeNull()
      expect(body.flash).toBe(false)
      expect(body.silenced).toBe(false)
      expect(body.unacknowledgedCount).toBe(0)
    })

    it('should reflect unacknowledged alert state', async () => {
      await raiseTestAlert(ctx, { priority: 'alarm' })

      const res = await fetch(`${ctx.baseUrl}/alerts/indication`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.audible).toBe(true)
      expect(body.priority).toBe('alarm')
      expect(body.flash).toBe(true)
      expect(body.unacknowledgedCount).toBe(1)
    })
  })

  // =========================================================================
  // GET /alerts/history
  // =========================================================================

  describe('GET /alerts/history', () => {
    it('should return history entries', async () => {
      // Raise an alert to generate history
      await raiseTestAlert(ctx)

      // Wait for async history logging
      await new Promise((r) => setTimeout(r, 50))

      const res = await fetch(`${ctx.baseUrl}/alerts/history`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        entries: HistoryEntry[]
        total: number
      }
      expect(body.entries).toBeDefined()
      expect(body.total).toBeGreaterThanOrEqual(0)
    })

    it('should support alertId filter', async () => {
      const alert = await raiseTestAlert(ctx)
      await new Promise((r) => setTimeout(r, 50))

      const res = await fetch(`${ctx.baseUrl}/alerts/history?alertId=${alert.id}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        entries: HistoryEntry[]
        total: number
      }
      expect(body.entries.every((e) => e.alertId === alert.id)).toBe(true)
    })

    it('should support pagination with limit and offset', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/history?limit=10&offset=0`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        entries: HistoryEntry[]
        total: number
      }
      expect(body.entries).toBeDefined()
    })

    it('should support date range filters', async () => {
      const res = await fetch(
        `${ctx.baseUrl}/alerts/history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`
      )
      expect(res.status).toBe(200)
    })

    it('should support eventType filter', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/history?eventType=raise,acknowledge`)
      expect(res.status).toBe(200)
    })

    it('should return 400 for invalid limit', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/history?limit=abc`)
      expect(res.status).toBe(400)
    })

    it('should return 400 for negative limit', async () => {
      const res = await fetch(`${ctx.baseUrl}/alerts/history?limit=-1`)
      expect(res.status).toBe(400)
    })
  })

  // =========================================================================
  // 503 when not initialized
  // =========================================================================

  describe('503 when not initialized', () => {
    let uninitApp: Express
    let uninitServer: http.Server
    let uninitBaseUrl: string

    beforeAll(() => {
      uninitApp = express()
      uninitApp.use(express.json())
      const deps: RouteDependencies = {
        getAlertManager: () => undefined,
        getHistoryStore: () => undefined
      }
      registerRoutes(uninitApp, deps)
      uninitServer = uninitApp.listen(0)
      const port = (uninitServer.address() as AddressInfo).port
      uninitBaseUrl = `http://127.0.0.1:${String(port)}`
    })

    afterAll(() => {
      uninitServer.close()
    })

    it('GET /alerts should return 503', async () => {
      const res = await fetch(`${uninitBaseUrl}/alerts`)
      expect(res.status).toBe(503)
    })

    it('POST /alerts should return 503', async () => {
      const res = await fetch(`${uninitBaseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'alarm', message: 'test' })
      })
      expect(res.status).toBe(503)
    })

    it('GET /alerts/indication should return 503', async () => {
      const res = await fetch(`${uninitBaseUrl}/alerts/indication`)
      expect(res.status).toBe(503)
    })

    it('GET /alerts/history should return 503', async () => {
      const res = await fetch(`${uninitBaseUrl}/alerts/history`)
      expect(res.status).toBe(503)
    })
  })
})
