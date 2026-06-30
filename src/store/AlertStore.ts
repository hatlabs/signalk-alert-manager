/**
 * Alert Store
 *
 * SQLite-based persistence layer for alerts using Node.js 22+ built-in
 * node:sqlite module.
 *
 * @see docs/ARCHITECTURE.md Section 2.2 for storage requirements
 */

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'fs'
import * as path from 'path'
import type { Alert, AlertFilter, IAlertStore } from '../types.js'

/**
 * SQLite-based implementation of IAlertStore.
 *
 * Uses the synchronous DatabaseSync API from node:sqlite, wrapped in
 * Promise-returning methods for the async IAlertStore interface.
 */
export class AlertStore implements IAlertStore {
  private dbPath: string
  private db: DatabaseSync | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  /**
   * Initialize the store - create database and tables.
   * Safe to call multiple times (idempotent).
   */
  initialize(): Promise<void> {
    // Already initialized - return early to avoid resource leaks
    if (this.db) {
      return Promise.resolve()
    }

    try {
      // Create parent directories if needed
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // Open database
      const db = new DatabaseSync(this.dbPath)
      this.db = db

      // Enable WAL mode for better concurrency
      db.exec('PRAGMA journal_mode = WAL')

      // Run migrations
      this.runMigrations(db)

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Close the database connection.
   */
  close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }

    return Promise.resolve()
  }

  /**
   * Save a new alert to the store.
   */
  save(alert: Alert): Promise<void> {
    try {
      const db = this.getDb()

      const stmt = db.prepare(`
        INSERT INTO alerts (
          id, path, source_ref, source_obj, priority, state, condition, latching, silenced,
          silenced_until, message, group_name, data, raised_at, acknowledged_at,
          acknowledged_by, cleared_at, source_online, last_source_update, stale, context
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)

      stmt.run(
        alert.id,
        alert.path,
        alert.$source,
        alert.source ? JSON.stringify(alert.source) : null,
        alert.priority,
        alert.state,
        alert.condition ? 1 : 0,
        alert.latching ? 1 : 0,
        alert.silenced ? 1 : 0,
        alert.silencedUntil ?? null,
        alert.message,
        alert.group ?? null,
        alert.data ? JSON.stringify(alert.data) : null,
        alert.raisedAt,
        alert.acknowledgedAt ?? null,
        alert.acknowledgedBy ?? null,
        alert.clearedAt ?? null,
        alert.sourceOnline ? 1 : 0,
        alert.lastSourceUpdate,
        alert.stale ? 1 : 0,
        alert.context ?? null
      )

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Retrieve an alert by ID.
   */
  get(id: string): Promise<Alert | null> {
    try {
      const db = this.getDb()

      const stmt = db.prepare('SELECT * FROM alerts WHERE id = ?')
      const row = stmt.get(id) as AlertRow | undefined

      if (!row) {
        return Promise.resolve(null)
      }

      return Promise.resolve(this.rowToAlert(row))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Retrieve all alerts matching the optional filter.
   */
  getAll(filter?: AlertFilter): Promise<Alert[]> {
    try {
      const db = this.getDb()

      let sql = 'SELECT * FROM alerts WHERE 1=1'
      const params: (string | number)[] = []

      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state]
        const placeholders = states.map(() => '?').join(', ')
        sql += ` AND state IN (${placeholders})`
        params.push(...states)
      }

      if (filter?.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
        const placeholders = priorities.map(() => '?').join(', ')
        sql += ` AND priority IN (${placeholders})`
        params.push(...priorities)
      }

      if (filter?.group) {
        sql += ' AND group_name = ?'
        params.push(filter.group)
      }

      if (filter?.stale !== undefined) {
        sql += ' AND stale = ?'
        params.push(filter.stale ? 1 : 0)
      }

      const stmt = db.prepare(sql)
      const rows = stmt.all(...params) as unknown as AlertRow[]

      return Promise.resolve(rows.map((row) => this.rowToAlert(row)))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Update an existing alert in the store.
   */
  update(alert: Alert): Promise<void> {
    try {
      const db = this.getDb()

      const stmt = db.prepare(`
        UPDATE alerts SET
          path = ?,
          source_ref = ?,
          source_obj = ?,
          priority = ?,
          state = ?,
          condition = ?,
          latching = ?,
          silenced = ?,
          silenced_until = ?,
          message = ?,
          group_name = ?,
          data = ?,
          raised_at = ?,
          acknowledged_at = ?,
          acknowledged_by = ?,
          cleared_at = ?,
          source_online = ?,
          last_source_update = ?,
          stale = ?,
          context = ?
        WHERE id = ?
      `)

      const result = stmt.run(
        alert.path,
        alert.$source,
        alert.source ? JSON.stringify(alert.source) : null,
        alert.priority,
        alert.state,
        alert.condition ? 1 : 0,
        alert.latching ? 1 : 0,
        alert.silenced ? 1 : 0,
        alert.silencedUntil ?? null,
        alert.message,
        alert.group ?? null,
        alert.data ? JSON.stringify(alert.data) : null,
        alert.raisedAt,
        alert.acknowledgedAt ?? null,
        alert.acknowledgedBy ?? null,
        alert.clearedAt ?? null,
        alert.sourceOnline ? 1 : 0,
        alert.lastSourceUpdate,
        alert.stale ? 1 : 0,
        alert.context ?? null,
        alert.id
      )

      if (result.changes === 0) {
        return Promise.reject(new Error(`Alert not found: ${alert.id}`))
      }

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Delete an alert from the store.
   */
  delete(id: string): Promise<void> {
    try {
      const db = this.getDb()

      const stmt = db.prepare('DELETE FROM alerts WHERE id = ?')
      stmt.run(id)

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Run schema migrations.
   */
  private runMigrations(db: DatabaseSync): void {
    // Create schema_version table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)

    const stmt = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    const row = stmt.get() as { version: number } | undefined
    const currentVersion = row?.version ?? 0

    if (currentVersion < 1) {
      this.migrateToV1(db)
    }
    if (currentVersion < 2) {
      this.migrateToV2(db)
    }
    if (currentVersion < 3) {
      this.migrateToV3(db)
    }
  }

  /**
   * Migration to schema version 1.
   * Wrapped in a transaction for atomicity.
   */
  private migrateToV1(db: DatabaseSync): void {
    db.exec('BEGIN TRANSACTION')
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source_id TEXT NOT NULL,
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

      // Create indexes for common query patterns
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);
        CREATE INDEX IF NOT EXISTS idx_alerts_priority ON alerts(priority);
        CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category);
        CREATE INDEX IF NOT EXISTS idx_alerts_source_id ON alerts(source_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_path ON alerts(path);
      `)

      // Create history table for future use (Issue #12)
      db.exec(`
        CREATE TABLE IF NOT EXISTS history (
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

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_alert_id ON history(alert_id);
        CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);
      `)

      // Record migration
      const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      stmt.run(1, new Date().toISOString())

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Migration to schema version 2.
   * Renames source_id → source_ref, adds source_obj column.
   */
  private migrateToV2(db: DatabaseSync): void {
    db.exec('BEGIN TRANSACTION')
    try {
      db.exec('ALTER TABLE alerts RENAME COLUMN source_id TO source_ref')
      db.exec('ALTER TABLE alerts ADD COLUMN source_obj TEXT')
      db.exec('DROP INDEX IF EXISTS idx_alerts_source_id')
      db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_source_ref ON alerts(source_ref)')

      const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      stmt.run(2, new Date().toISOString())

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Migration to schema version 3.
   * Renames the free-text grouping column category → group_name
   * (group is a SQL reserved word) and updates its index.
   */
  private migrateToV3(db: DatabaseSync): void {
    db.exec('BEGIN TRANSACTION')
    try {
      db.exec('ALTER TABLE alerts RENAME COLUMN category TO group_name')
      db.exec('DROP INDEX IF EXISTS idx_alerts_category')
      db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts(group_name)')

      const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      stmt.run(3, new Date().toISOString())

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Get the database, throwing if not initialized.
   */
  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('AlertStore not initialized. Call initialize() first.')
    }
    return this.db
  }

  /**
   * Convert a database row to an Alert object.
   */
  private rowToAlert(row: AlertRow): Alert {
    const alert: Alert = {
      id: row.id,
      path: row.path,
      $source: row.source_ref,
      priority: row.priority as Alert['priority'],
      state: row.state as Alert['state'],
      condition: row.condition === 1,
      latching: row.latching === 1,
      silenced: row.silenced === 1,
      message: row.message,
      raisedAt: row.raised_at,
      sourceOnline: row.source_online === 1,
      lastSourceUpdate: row.last_source_update,
      stale: row.stale === 1
    }

    // Add optional fields if present
    if (row.source_obj) {
      try {
        alert.source = JSON.parse(row.source_obj) as Record<string, unknown>
      } catch {
        // Malformed JSON in database - skip this field rather than failing entirely
      }
    }
    if (row.silenced_until) {
      alert.silencedUntil = row.silenced_until
    }
    if (row.group_name) {
      alert.group = row.group_name
    }
    if (row.data) {
      try {
        alert.data = JSON.parse(row.data) as Record<string, unknown>
      } catch {
        // Malformed JSON in database - skip this field rather than failing entirely
      }
    }
    if (row.acknowledged_at) {
      alert.acknowledgedAt = row.acknowledged_at
    }
    if (row.acknowledged_by) {
      alert.acknowledgedBy = row.acknowledged_by
    }
    if (row.cleared_at) {
      alert.clearedAt = row.cleared_at
    }
    if (row.context) {
      alert.context = row.context
    }

    return alert
  }
}

/**
 * Type for database row from alerts table.
 */
interface AlertRow {
  id: string
  path: string
  source_ref: string
  source_obj: string | null
  priority: string
  state: string
  condition: number
  latching: number
  silenced: number
  silenced_until: string | null
  message: string
  group_name: string | null
  data: string | null
  raised_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
  cleared_at: string | null
  source_online: number
  last_source_update: string
  stale: number
  context: string | null
}
