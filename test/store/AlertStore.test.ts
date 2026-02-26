import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AlertStore } from '../../src/store/AlertStore.js'
import type { Alert } from '../../src/types.js'

/**
 * Create a test alert with required fields.
 */
function createTestAlert(overrides: Partial<Alert> = {}): Alert {
  const now = new Date().toISOString()
  return {
    id: `test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
    path: 'test.alert',
    $source: 'test-source',
    priority: 'alarm',
    state: 'unacknowledged',
    condition: true,
    latching: false,
    silenced: false,
    message: 'Test alert message',
    raisedAt: now,
    sourceOnline: true,
    lastSourceUpdate: now,
    stale: false,
    ...overrides
  }
}

describe('AlertStore', () => {
  let store: AlertStore
  let testDbPath: string

  beforeEach(() => {
    // Create a unique temp directory for each test
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertstore-test-'))
    testDbPath = path.join(tempDir, 'alerts.db')
    store = new AlertStore(testDbPath)
  })

  afterEach(async () => {
    await store.close()
    // Clean up temp directory
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

    it('should create alerts table', async () => {
      await store.initialize()

      // Verify by trying to save an alert
      const alert = createTestAlert()
      await expect(store.save(alert)).resolves.not.toThrow()
    })

    it('should be idempotent - multiple initializations are safe', async () => {
      await store.initialize()
      await store.initialize()
      await store.initialize()

      // Should still work
      const alert = createTestAlert()
      await store.save(alert)
      const retrieved = await store.get(alert.id)
      expect(retrieved).not.toBeNull()
    })

    it('should open existing database without error', async () => {
      // First initialization
      await store.initialize()
      const alert = createTestAlert()
      await store.save(alert)
      await store.close()

      // Reopen
      store = new AlertStore(testDbPath)
      await store.initialize()

      // Data should persist
      const retrieved = await store.get(alert.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.message).toBe(alert.message)
    })

    it('should create parent directories if needed', async () => {
      const nestedPath = path.join(
        os.tmpdir(),
        `alertstore-nested-${String(Date.now())}`,
        'sub',
        'dir',
        'alerts.db'
      )
      const nestedStore = new AlertStore(nestedPath)

      await nestedStore.initialize()

      expect(fs.existsSync(nestedPath)).toBe(true)

      await nestedStore.close()
      fs.rmSync(path.dirname(path.dirname(path.dirname(nestedPath))), { recursive: true })
    })
  })

  describe('save', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should save an alert', async () => {
      const alert = createTestAlert()

      await store.save(alert)

      const retrieved = await store.get(alert.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(alert.id)
    })

    it('should preserve all alert fields', async () => {
      const alert = createTestAlert({
        category: 'engine',
        data: { temperature: 95, threshold: 90 },
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'user-1',
        clearedAt: new Date().toISOString(),
        silencedUntil: new Date().toISOString(),
        context: 'vessels.self'
      })

      await store.save(alert)

      const retrieved = await store.get(alert.id)
      expect(retrieved).toEqual(alert)
    })

    it('should handle alerts without optional fields', async () => {
      const alert = createTestAlert()
      // Ensure optional fields are undefined
      delete alert.category
      delete alert.data
      delete alert.acknowledgedAt
      delete alert.acknowledgedBy
      delete alert.clearedAt
      delete alert.silencedUntil
      delete alert.context

      await store.save(alert)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.id).toBe(alert.id)
      expect(retrieved?.category).toBeUndefined()
    })

    it('should throw on duplicate ID', async () => {
      const alert = createTestAlert()
      await store.save(alert)

      await expect(store.save(alert)).rejects.toThrow()
    })
  })

  describe('get', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should return null for non-existent alert', async () => {
      const result = await store.get('non-existent-id')

      expect(result).toBeNull()
    })

    it('should return the alert if it exists', async () => {
      const alert = createTestAlert()
      await store.save(alert)

      const result = await store.get(alert.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(alert.id)
    })
  })

  describe('getAll', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should return empty array when no alerts', async () => {
      const result = await store.getAll()

      expect(result).toEqual([])
    })

    it('should return all alerts without filter', async () => {
      const alert1 = createTestAlert({ id: 'alert-1' })
      const alert2 = createTestAlert({ id: 'alert-2' })
      await store.save(alert1)
      await store.save(alert2)

      const result = await store.getAll()

      expect(result).toHaveLength(2)
    })

    it('should filter by state', async () => {
      const unacked = createTestAlert({ id: 'unacked', state: 'unacknowledged' })
      const acked = createTestAlert({ id: 'acked', state: 'acknowledged' })
      await store.save(unacked)
      await store.save(acked)

      const result = await store.getAll({ state: 'unacknowledged' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('unacked')
    })

    it('should filter by multiple states', async () => {
      const unacked = createTestAlert({ id: 'unacked', state: 'unacknowledged' })
      const acked = createTestAlert({ id: 'acked', state: 'acknowledged' })
      const rtn = createTestAlert({ id: 'rtn', state: 'rtn-unacknowledged' })
      await store.save(unacked)
      await store.save(acked)
      await store.save(rtn)

      const result = await store.getAll({ state: ['unacknowledged', 'rtn-unacknowledged'] })

      expect(result).toHaveLength(2)
    })

    it('should filter by priority', async () => {
      const alarm = createTestAlert({ id: 'alarm', priority: 'alarm' })
      const warning = createTestAlert({ id: 'warning', priority: 'warning' })
      await store.save(alarm)
      await store.save(warning)

      const result = await store.getAll({ priority: 'alarm' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('alarm')
    })

    it('should filter by multiple priorities', async () => {
      const alarm = createTestAlert({ id: 'alarm', priority: 'alarm' })
      const warning = createTestAlert({ id: 'warning', priority: 'warning' })
      const caution = createTestAlert({ id: 'caution', priority: 'caution' })
      await store.save(alarm)
      await store.save(warning)
      await store.save(caution)

      const result = await store.getAll({ priority: ['alarm', 'emergency'] })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('alarm')
    })

    it('should filter by category', async () => {
      const engine = createTestAlert({ id: 'engine', category: 'engine' })
      const nav = createTestAlert({ id: 'nav', category: 'navigation' })
      await store.save(engine)
      await store.save(nav)

      const result = await store.getAll({ category: 'engine' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('engine')
    })

    it('should filter by stale status', async () => {
      const stale = createTestAlert({ id: 'stale', stale: true })
      const fresh = createTestAlert({ id: 'fresh', stale: false })
      await store.save(stale)
      await store.save(fresh)

      const result = await store.getAll({ stale: true })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('stale')
    })

    it('should combine multiple filters', async () => {
      const match = createTestAlert({
        id: 'match',
        state: 'unacknowledged',
        priority: 'alarm',
        category: 'engine'
      })
      const noMatch1 = createTestAlert({
        id: 'no-match-1',
        state: 'acknowledged',
        priority: 'alarm',
        category: 'engine'
      })
      const noMatch2 = createTestAlert({
        id: 'no-match-2',
        state: 'unacknowledged',
        priority: 'warning',
        category: 'engine'
      })
      await store.save(match)
      await store.save(noMatch1)
      await store.save(noMatch2)

      const result = await store.getAll({
        state: 'unacknowledged',
        priority: 'alarm',
        category: 'engine'
      })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('match')
    })
  })

  describe('update', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should update an existing alert', async () => {
      const alert = createTestAlert()
      await store.save(alert)

      const updated = {
        ...alert,
        state: 'acknowledged' as const,
        acknowledgedAt: new Date().toISOString()
      }
      await store.update(updated)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.state).toBe('acknowledged')
      expect(retrieved?.acknowledgedAt).toBe(updated.acknowledgedAt)
    })

    it('should throw for non-existent alert', async () => {
      const alert = createTestAlert()

      await expect(store.update(alert)).rejects.toThrow()
    })

    it('should preserve other fields when updating', async () => {
      const alert = createTestAlert({
        category: 'engine',
        data: { value: 1 }
      })
      await store.save(alert)

      const updated = { ...alert, silenced: true }
      await store.update(updated)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.silenced).toBe(true)
      expect(retrieved?.category).toBe('engine')
      expect(retrieved?.data).toEqual({ value: 1 })
    })
  })

  describe('delete', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should delete an existing alert', async () => {
      const alert = createTestAlert()
      await store.save(alert)

      await store.delete(alert.id)

      const retrieved = await store.get(alert.id)
      expect(retrieved).toBeNull()
    })

    it('should not throw for non-existent alert', async () => {
      await expect(store.delete('non-existent')).resolves.not.toThrow()
    })

    it('should only delete the specified alert', async () => {
      const alert1 = createTestAlert({ id: 'alert-1' })
      const alert2 = createTestAlert({ id: 'alert-2' })
      await store.save(alert1)
      await store.save(alert2)

      await store.delete('alert-1')

      expect(await store.get('alert-1')).toBeNull()
      expect(await store.get('alert-2')).not.toBeNull()
    })
  })

  describe('close', () => {
    it('should close the database connection', async () => {
      await store.initialize()
      const alert = createTestAlert()
      await store.save(alert)

      await store.close()

      // Operations after close should throw or fail gracefully
      // Re-opening should work
      store = new AlertStore(testDbPath)
      await store.initialize()
      const retrieved = await store.get(alert.id)
      expect(retrieved).not.toBeNull()
    })

    it('should be idempotent - multiple closes are safe', async () => {
      await store.initialize()

      await expect(store.close()).resolves.not.toThrow()
      await expect(store.close()).resolves.not.toThrow()
    })
  })

  describe('data persistence', () => {
    it('should persist data across store instances', async () => {
      // Save data
      await store.initialize()
      const alert1 = createTestAlert({ id: 'persistent-1', message: 'Persistent alert 1' })
      const alert2 = createTestAlert({ id: 'persistent-2', message: 'Persistent alert 2' })
      await store.save(alert1)
      await store.save(alert2)
      await store.close()

      // Reopen and verify
      store = new AlertStore(testDbPath)
      await store.initialize()
      const alerts = await store.getAll()

      expect(alerts).toHaveLength(2)
      expect(alerts.map((a) => a.id).sort()).toEqual(['persistent-1', 'persistent-2'])
    })
  })

  describe('robustness', () => {
    it('should handle malformed JSON in data field gracefully', async () => {
      await store.initialize()

      // Save an alert with valid data
      const alert = createTestAlert({ id: 'malformed-test' })
      await store.save(alert)

      // Manually corrupt the JSON data in the database using a raw SQL update
      // We need to access the database directly for this test
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(testDbPath)
      db.exec("UPDATE alerts SET data = '{invalid json' WHERE id = 'malformed-test'")
      db.close()

      // Reopen store and verify it handles the malformed data gracefully
      await store.close()
      store = new AlertStore(testDbPath)
      await store.initialize()

      const retrieved = await store.get('malformed-test')

      // Should return the alert without the data field (graceful degradation)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe('malformed-test')
      expect(retrieved?.data).toBeUndefined()
    })
  })

  describe('concurrent access', () => {
    it('should handle concurrent read and write operations', async () => {
      await store.initialize()

      // Create multiple alerts concurrently
      const alerts = Array.from({ length: 10 }, (_, i) =>
        createTestAlert({ id: `concurrent-${String(i)}`, message: `Alert ${String(i)}` })
      )

      // Save all alerts concurrently
      await Promise.all(alerts.map((alert) => store.save(alert)))

      // Read all alerts concurrently
      const [all, single1, single2] = await Promise.all([
        store.getAll(),
        store.get('concurrent-0'),
        store.get('concurrent-5')
      ])

      expect(all).toHaveLength(10)
      expect(single1?.id).toBe('concurrent-0')
      expect(single2?.id).toBe('concurrent-5')

      // Update and delete concurrently
      const updated = { ...alerts[0], message: 'Updated' }
      await Promise.all([store.update(updated), store.delete('concurrent-9')])

      const afterOps = await store.getAll()
      expect(afterOps).toHaveLength(9)
      expect(afterOps.find((a) => a.id === 'concurrent-0')?.message).toBe('Updated')
    })
  })

  describe('schema migrations', () => {
    it('should create required tables on initialization', async () => {
      await store.initialize()

      // Verify migrations ran successfully by testing that CRUD operations work
      const alert = createTestAlert()
      await store.save(alert)
      const retrieved = await store.get(alert.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(alert.id)
    })
  })
})
