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
    stateChangedAt: now,
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
        group: 'engine',
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
      delete alert.group
      delete alert.data
      delete alert.acknowledgedAt
      delete alert.acknowledgedBy
      delete alert.clearedAt
      delete alert.silencedUntil
      delete alert.context

      await store.save(alert)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.id).toBe(alert.id)
      expect(retrieved?.group).toBeUndefined()
    })

    it('should round-trip stateChangedAt independently of raisedAt', async () => {
      const alert = createTestAlert({
        raisedAt: '2026-03-01T10:00:00.000Z',
        stateChangedAt: '2026-03-01T11:30:00.000Z'
      })

      await store.save(alert)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.stateChangedAt).toBe('2026-03-01T11:30:00.000Z')
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

    it('should filter by group', async () => {
      const engine = createTestAlert({ id: 'engine', group: 'engine' })
      const nav = createTestAlert({ id: 'nav', group: 'navigation' })
      await store.save(engine)
      await store.save(nav)

      const result = await store.getAll({ group: 'engine' })

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
        group: 'engine'
      })
      const noMatch1 = createTestAlert({
        id: 'no-match-1',
        state: 'acknowledged',
        priority: 'alarm',
        group: 'engine'
      })
      const noMatch2 = createTestAlert({
        id: 'no-match-2',
        state: 'unacknowledged',
        priority: 'warning',
        group: 'engine'
      })
      await store.save(match)
      await store.save(noMatch1)
      await store.save(noMatch2)

      const result = await store.getAll({
        state: 'unacknowledged',
        priority: 'alarm',
        group: 'engine'
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
        group: 'engine',
        data: { value: 1 }
      })
      await store.save(alert)

      const updated = { ...alert, silenced: true }
      await store.update(updated)

      const retrieved = await store.get(alert.id)
      expect(retrieved?.silenced).toBe(true)
      expect(retrieved?.group).toBe('engine')
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

    it('migration v4 backfills state_changed_at from raised_at for pre-v4 rows', async () => {
      const { DatabaseSync } = await import('node:sqlite')

      // Build a pre-v4 (schema version 3) database by hand: the alerts table
      // has no state_changed_at column yet.
      const legacyDb = new DatabaseSync(testDbPath)
      legacyDb.exec('PRAGMA journal_mode = WAL')
      legacyDb.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
        INSERT INTO schema_version (version, applied_at) VALUES (2, '2026-01-01T00:00:00Z');
        INSERT INTO schema_version (version, applied_at) VALUES (3, '2026-01-01T00:00:00Z');
      `)
      legacyDb.exec(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          source_obj TEXT,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          condition INTEGER NOT NULL,
          latching INTEGER NOT NULL,
          silenced INTEGER NOT NULL,
          silenced_until TEXT,
          message TEXT NOT NULL,
          group_name TEXT,
          data TEXT,
          raised_at TEXT NOT NULL,
          acknowledged_at TEXT,
          acknowledged_by TEXT,
          cleared_at TEXT,
          source_online INTEGER NOT NULL,
          last_source_update TEXT NOT NULL,
          stale INTEGER NOT NULL,
          context TEXT
        )
      `)
      legacyDb
        .prepare(
          `INSERT INTO alerts (
            id, path, source_ref, priority, state, condition, latching, silenced,
            message, raised_at, source_online, last_source_update, stale
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'legacy-1',
          'legacy.alert',
          'legacy-source',
          'alarm',
          'unacknowledged',
          1,
          0,
          0,
          'Legacy alert',
          '2026-03-01T12:00:00.000Z',
          1,
          '2026-03-01T12:00:00.000Z',
          0
        )
      legacyDb.close()

      // Opening the store runs migrateToV4, which adds and backfills the column.
      await store.initialize()

      const retrieved = await store.get('legacy-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.stateChangedAt).toBe('2026-03-01T12:00:00.000Z')
    })

    it('migration v3 preserves category data as group when upgrading from v2', async () => {
      const { DatabaseSync } = await import('node:sqlite')

      // Build a schema-version-2 database by hand: the alerts table still has a
      // `category` column (renamed to group_name in v3) and its index, and no
      // state_changed_at column (added in v4).
      const legacyDb = new DatabaseSync(testDbPath)
      legacyDb.exec('PRAGMA journal_mode = WAL')
      legacyDb.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
        INSERT INTO schema_version (version, applied_at) VALUES (2, '2026-01-01T00:00:00Z');
      `)
      legacyDb.exec(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          source_obj TEXT,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          condition INTEGER NOT NULL,
          latching INTEGER NOT NULL,
          silenced INTEGER NOT NULL,
          silenced_until TEXT,
          message TEXT NOT NULL,
          category TEXT,
          data TEXT,
          raised_at TEXT NOT NULL,
          acknowledged_at TEXT,
          acknowledged_by TEXT,
          cleared_at TEXT,
          source_online INTEGER NOT NULL,
          last_source_update TEXT NOT NULL,
          stale INTEGER NOT NULL,
          context TEXT
        )
      `)
      legacyDb.exec('CREATE INDEX idx_alerts_category ON alerts(category)')
      // A real v2 database always carries the history table (created at v1).
      legacyDb.exec(`
        CREATE TABLE history (
          id TEXT PRIMARY KEY,
          alert_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          user_id TEXT,
          previous_state TEXT,
          new_state TEXT,
          previous_priority TEXT,
          new_priority TEXT,
          details TEXT
        )
      `)
      legacyDb
        .prepare(
          `INSERT INTO alerts (
            id, path, source_ref, priority, state, condition, latching, silenced,
            message, category, raised_at, source_online, last_source_update, stale
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'legacy-v2',
          'legacy.alert',
          'legacy-source',
          'alarm',
          'unacknowledged',
          1,
          0,
          0,
          'Legacy v2 alert',
          'engine',
          '2026-03-01T12:00:00.000Z',
          1,
          '2026-03-01T12:00:00.000Z',
          0
        )
      legacyDb.close()

      // Opening the store runs migrateToV3 (category → group_name) then
      // migrateToV4 (adds state_changed_at).
      await store.initialize()

      // The category value survives and reads back via the group field.
      const retrieved = await store.get('legacy-v2')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.group).toBe('engine')

      // Group filtering works against the migrated column.
      const filtered = await store.getAll({ group: 'engine' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].id).toBe('legacy-v2')

      // The migration chain reached version 4.
      const versionDb = new DatabaseSync(testDbPath)
      const versionRow = versionDb
        .prepare('SELECT MAX(version) AS version FROM schema_version')
        .get() as { version: number }
      versionDb.close()
      expect(versionRow.version).toBe(4)
    })

    it('migration v3 rewrites legacy history details category key to group', async () => {
      const { DatabaseSync } = await import('node:sqlite')

      // Build a schema-version-2 database whose history snapshot embeds the
      // grouping under the old `category` key (AlertManager.logHistory now
      // writes `group`).
      const legacyDb = new DatabaseSync(testDbPath)
      legacyDb.exec('PRAGMA journal_mode = WAL')
      legacyDb.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
        INSERT INTO schema_version (version, applied_at) VALUES (2, '2026-01-01T00:00:00Z');
      `)
      legacyDb.exec(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          source_obj TEXT,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          condition INTEGER NOT NULL,
          latching INTEGER NOT NULL,
          silenced INTEGER NOT NULL,
          silenced_until TEXT,
          message TEXT NOT NULL,
          category TEXT,
          data TEXT,
          raised_at TEXT NOT NULL,
          acknowledged_at TEXT,
          acknowledged_by TEXT,
          cleared_at TEXT,
          source_online INTEGER NOT NULL,
          last_source_update TEXT NOT NULL,
          stale INTEGER NOT NULL,
          context TEXT
        )
      `)
      legacyDb.exec('CREATE INDEX idx_alerts_category ON alerts(category)')
      legacyDb.exec(`
        CREATE TABLE history (
          id TEXT PRIMARY KEY,
          alert_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          user_id TEXT,
          previous_state TEXT,
          new_state TEXT,
          previous_priority TEXT,
          new_priority TEXT,
          details TEXT
        )
      `)
      legacyDb
        .prepare(
          `INSERT INTO history (id, alert_id, event_type, timestamp, details)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          'hist-1',
          'legacy-alert',
          'raise',
          '2026-03-01T12:00:00.000Z',
          JSON.stringify({ message: 'Legacy raised', priority: 'alarm', category: 'engine' })
        )
      // A null details blob must be left untouched, not crash the migration.
      legacyDb
        .prepare(
          `INSERT INTO history (id, alert_id, event_type, timestamp, details)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('hist-2', 'legacy-alert', 'acknowledge', '2026-03-01T12:05:00.000Z', null)
      legacyDb.close()

      await store.initialize()

      // The migrated snapshot renames category → group, preserving the value.
      const verifyDb = new DatabaseSync(testDbPath)
      const migratedRow = verifyDb
        .prepare('SELECT details FROM history WHERE id = ?')
        .get('hist-1') as { details: string }
      const nullRow = verifyDb
        .prepare('SELECT details FROM history WHERE id = ?')
        .get('hist-2') as { details: string | null }
      verifyDb.close()

      const details = JSON.parse(migratedRow.details) as Record<string, unknown>
      expect(details.group).toBe('engine')
      expect(details).not.toHaveProperty('category')
      expect(nullRow.details).toBeNull()
    })
  })
})
