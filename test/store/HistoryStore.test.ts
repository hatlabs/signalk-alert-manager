import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { HistoryStore } from '../../src/store/HistoryStore.js'
import type { HistoryEntry } from '../../src/types.js'

function createTestEntry(
  overrides: Partial<Omit<HistoryEntry, 'id'>> = {}
): Omit<HistoryEntry, 'id'> {
  return {
    alertId: 'alert-1',
    eventType: 'raise',
    timestamp: new Date().toISOString(),
    ...overrides
  }
}

describe('HistoryStore', () => {
  let store: HistoryStore
  let testDbPath: string

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historystore-test-'))
    testDbPath = path.join(tempDir, 'alerts.db')
    store = new HistoryStore(testDbPath)
  })

  afterEach(async () => {
    await store.close()
    const dir = path.dirname(testDbPath)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true })
    }
  })

  describe('initialize', () => {
    it('should create database file', async () => {
      await store.initialize()
      expect(fs.existsSync(testDbPath)).toBe(true)
    })

    it('should be idempotent', async () => {
      await store.initialize()
      await store.initialize()

      const entry = createTestEntry()
      await store.log(entry)
      const result = await store.query({})
      expect(result.total).toBe(1)
    })
  })

  describe('log', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should insert an entry and generate an ID', async () => {
      const entry = createTestEntry()
      await store.log(entry)

      const result = await store.query({})
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].id).toBeDefined()
      expect(result.entries[0].id.length).toBeGreaterThan(0)
    })

    it('should preserve all fields', async () => {
      const entry = createTestEntry({
        alertId: 'alert-42',
        eventType: 'escalate',
        timestamp: '2025-01-15T10:00:00.000Z',
        userId: 'user-1',
        previousState: 'unacknowledged',
        newState: 'unacknowledged',
        previousPriority: 'warning',
        newPriority: 'alarm',
        details: { reason: 'timeout' }
      })

      await store.log(entry)

      const result = await store.query({})
      const stored = result.entries[0]
      expect(stored.alertId).toBe('alert-42')
      expect(stored.eventType).toBe('escalate')
      expect(stored.timestamp).toBe('2025-01-15T10:00:00.000Z')
      expect(stored.userId).toBe('user-1')
      expect(stored.previousState).toBe('unacknowledged')
      expect(stored.newState).toBe('unacknowledged')
      expect(stored.previousPriority).toBe('warning')
      expect(stored.newPriority).toBe('alarm')
      expect(stored.details).toEqual({ reason: 'timeout' })
    })

    it('should handle entries with only required fields', async () => {
      const entry = createTestEntry()
      await store.log(entry)

      const result = await store.query({})
      const stored = result.entries[0]
      expect(stored.alertId).toBe('alert-1')
      expect(stored.eventType).toBe('raise')
      expect(stored.userId).toBeUndefined()
      expect(stored.previousState).toBeUndefined()
      expect(stored.newState).toBeUndefined()
      expect(stored.details).toBeUndefined()
    })
  })

  describe('query', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should return all entries with no filters', async () => {
      await store.log(createTestEntry({ alertId: 'a1' }))
      await store.log(createTestEntry({ alertId: 'a2' }))
      await store.log(createTestEntry({ alertId: 'a3' }))

      const result = await store.query({})
      expect(result.entries).toHaveLength(3)
      expect(result.total).toBe(3)
    })

    it('should filter by alertId', async () => {
      await store.log(createTestEntry({ alertId: 'a1' }))
      await store.log(createTestEntry({ alertId: 'a2' }))
      await store.log(createTestEntry({ alertId: 'a1', eventType: 'acknowledge' }))

      const result = await store.query({ alertId: 'a1' })
      expect(result.entries).toHaveLength(2)
      expect(result.entries.every((e) => e.alertId === 'a1')).toBe(true)
      expect(result.total).toBe(2)
    })

    it('should filter by date range (from)', async () => {
      await store.log(createTestEntry({ timestamp: '2025-01-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-06-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-12-01T00:00:00.000Z' }))

      const result = await store.query({ from: '2025-05-01T00:00:00.000Z' })
      expect(result.entries).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('should filter by date range (to)', async () => {
      await store.log(createTestEntry({ timestamp: '2025-01-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-06-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-12-01T00:00:00.000Z' }))

      const result = await store.query({ to: '2025-07-01T00:00:00.000Z' })
      expect(result.entries).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('should filter by date range (from and to)', async () => {
      await store.log(createTestEntry({ timestamp: '2025-01-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-06-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-12-01T00:00:00.000Z' }))

      const result = await store.query({
        from: '2025-03-01T00:00:00.000Z',
        to: '2025-09-01T00:00:00.000Z'
      })
      expect(result.entries).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('should support pagination with limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.log(createTestEntry({ alertId: `a${String(i)}` }))
      }

      const result = await store.query({ limit: 2 })
      expect(result.entries).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('should support pagination with offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.log(
          createTestEntry({
            alertId: `a${String(i)}`,
            timestamp: new Date(2025, 0, i + 1).toISOString()
          })
        )
      }

      const result = await store.query({ limit: 2, offset: 2 })
      expect(result.entries).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('should return entries ordered by timestamp descending', async () => {
      await store.log(createTestEntry({ timestamp: '2025-01-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-06-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ timestamp: '2025-03-01T00:00:00.000Z' }))

      const result = await store.query({})
      expect(result.entries[0].timestamp).toBe('2025-06-01T00:00:00.000Z')
      expect(result.entries[1].timestamp).toBe('2025-03-01T00:00:00.000Z')
      expect(result.entries[2].timestamp).toBe('2025-01-01T00:00:00.000Z')
    })

    it('should return correct total with combined filters and pagination', async () => {
      await store.log(createTestEntry({ alertId: 'a1', timestamp: '2025-01-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ alertId: 'a1', timestamp: '2025-06-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ alertId: 'a1', timestamp: '2025-12-01T00:00:00.000Z' }))
      await store.log(createTestEntry({ alertId: 'a2', timestamp: '2025-06-01T00:00:00.000Z' }))

      const result = await store.query({ alertId: 'a1', limit: 1 })
      expect(result.entries).toHaveLength(1)
      expect(result.total).toBe(3)
    })
  })

  describe('prune', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should delete old records and return count', async () => {
      const oldTimestamp = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
      const recentTimestamp = new Date().toISOString()

      await store.log(createTestEntry({ timestamp: oldTimestamp }))
      await store.log(createTestEntry({ timestamp: oldTimestamp }))
      await store.log(createTestEntry({ timestamp: recentTimestamp }))

      const deleted = await store.prune(90)

      expect(deleted).toBe(2)
      const result = await store.query({})
      expect(result.total).toBe(1)
    })

    it('should preserve recent records', async () => {
      const recentTimestamp = new Date().toISOString()
      await store.log(createTestEntry({ timestamp: recentTimestamp }))

      const deleted = await store.prune(90)

      expect(deleted).toBe(0)
      const result = await store.query({})
      expect(result.total).toBe(1)
    })

    it('should return 0 when nothing to prune', async () => {
      const deleted = await store.prune(90)
      expect(deleted).toBe(0)
    })
  })

  describe('close', () => {
    it('should close connection and data persists across reopen', async () => {
      await store.initialize()
      await store.log(createTestEntry())
      await store.close()

      store = new HistoryStore(testDbPath)
      await store.initialize()

      const result = await store.query({})
      expect(result.total).toBe(1)
    })

    it('should be idempotent', async () => {
      await store.initialize()
      await expect(store.close()).resolves.not.toThrow()
      await expect(store.close()).resolves.not.toThrow()
    })
  })

  describe('robustness', () => {
    it('should handle malformed JSON in details field', async () => {
      await store.initialize()
      await store.log(createTestEntry({ alertId: 'malformed-test' }))

      // Corrupt the JSON directly in the database
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(testDbPath)
      db.exec("UPDATE history SET details = '{broken json' WHERE alert_id = 'malformed-test'")
      db.close()

      // Reopen and query
      await store.close()
      store = new HistoryStore(testDbPath)
      await store.initialize()

      const result = await store.query({ alertId: 'malformed-test' })
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].details).toBeUndefined()
    })
  })
})
