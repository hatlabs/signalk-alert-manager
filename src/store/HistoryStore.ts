/**
 * History Store
 *
 * SQLite-based persistence layer for alert history using Node.js 22+
 * built-in node:sqlite module.
 *
 * Opens its own connection to the same database file as AlertStore.
 * WAL mode allows concurrent read/write access across connections.
 */

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'fs'
import * as path from 'path'
import type {
  HistoryEntry,
  HistoryEventType,
  HistoryQuery,
  IHistoryStore,
  AlertPriority,
  AlertState
} from '../types.js'

interface HistoryRow {
  id: string
  alert_id: string
  event_type: string
  timestamp: string
  user_id: string | null
  previous_state: string | null
  new_state: string | null
  previous_priority: string | null
  new_priority: string | null
  details: string | null
}

export class HistoryStore implements IHistoryStore {
  private dbPath: string
  private db: DatabaseSync | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  initialize(): Promise<void> {
    if (this.db) {
      return Promise.resolve()
    }

    try {
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const db = new DatabaseSync(this.dbPath)
      this.db = db

      db.exec('PRAGMA journal_mode = WAL')

      // The history table is created by AlertStore's v1 migration.
      // Create it here too for standalone use (e.g., tests).
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

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    return Promise.resolve()
  }

  log(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    try {
      const db = this.getDb()
      const id = crypto.randomUUID()

      const stmt = db.prepare(`
        INSERT INTO history (
          id, alert_id, event_type, timestamp, user_id,
          previous_state, new_state, previous_priority, new_priority, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      stmt.run(
        id,
        entry.alertId,
        entry.eventType,
        entry.timestamp,
        entry.userId ?? null,
        entry.previousState ?? null,
        entry.newState ?? null,
        entry.previousPriority ?? null,
        entry.newPriority ?? null,
        entry.details ? JSON.stringify(entry.details) : null
      )

      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  query(query: HistoryQuery): Promise<{ entries: HistoryEntry[]; total: number }> {
    try {
      const db = this.getDb()

      let whereSql = 'WHERE 1=1'
      const params: (string | number)[] = []

      if (query.alertId) {
        whereSql += ' AND alert_id = ?'
        params.push(query.alertId)
      }
      if (query.from) {
        whereSql += ' AND timestamp >= ?'
        params.push(query.from)
      }
      if (query.to) {
        whereSql += ' AND timestamp <= ?'
        params.push(query.to)
      }

      // Count total matching rows (before pagination)
      const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM history ${whereSql}`)
      const countRow = countStmt.get(...params) as { cnt: number }
      const total = countRow.cnt

      // Fetch paginated results
      let dataSql = `SELECT * FROM history ${whereSql} ORDER BY timestamp DESC`
      const dataParams = [...params]

      if (query.limit !== undefined) {
        dataSql += ' LIMIT ?'
        dataParams.push(query.limit)
      }
      if (query.offset !== undefined) {
        dataSql += ' OFFSET ?'
        dataParams.push(query.offset)
      }

      const dataStmt = db.prepare(dataSql)
      const rows = dataStmt.all(...dataParams) as unknown as HistoryRow[]

      const entries = rows.map((row) => this.rowToHistoryEntry(row))

      return Promise.resolve({ entries, total })
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  prune(olderThanDays: number): Promise<number> {
    try {
      const db = this.getDb()
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()

      const stmt = db.prepare('DELETE FROM history WHERE timestamp < ?')
      const result = stmt.run(cutoff)

      return Promise.resolve(Number(result.changes))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('HistoryStore not initialized. Call initialize() first.')
    }
    return this.db
  }

  private rowToHistoryEntry(row: HistoryRow): HistoryEntry {
    const entry: HistoryEntry = {
      id: row.id,
      alertId: row.alert_id,
      eventType: row.event_type as HistoryEventType,
      timestamp: row.timestamp
    }

    if (row.user_id) {
      entry.userId = row.user_id
    }
    if (row.previous_state) {
      entry.previousState = row.previous_state as AlertState
    }
    if (row.new_state) {
      entry.newState = row.new_state as AlertState
    }
    if (row.previous_priority) {
      entry.previousPriority = row.previous_priority as AlertPriority
    }
    if (row.new_priority) {
      entry.newPriority = row.new_priority as AlertPriority
    }
    if (row.details) {
      try {
        entry.details = JSON.parse(row.details) as Record<string, unknown>
      } catch {
        // Malformed JSON - skip field rather than failing
      }
    }

    return entry
  }
}
