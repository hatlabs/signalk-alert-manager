/**
 * E2E Persistence Tests
 *
 * Verifies that alerts and history survive a server restart.
 * Uses a shared config directory across stop/start cycles.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AlertClient } from './helpers/client.js'
import { createTempConfig, startServerFromConfig, type ManagedServer } from './helpers/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '../..')

describe('Persistence across restarts', () => {
  let configDir: string
  let managed: ManagedServer
  let client: AlertClient
  let persistedAlertId: string

  beforeAll(() => {
    configDir = fs.mkdtempSync(path.join(PLUGIN_ROOT, '.e2e-persist-'))
    createTempConfig(configDir)
  })

  afterAll(() => {
    // Clean up temp directory
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('should start server and raise an alert', async () => {
    managed = await startServerFromConfig(configDir)
    client = new AlertClient(managed.host)

    const alert = await client.raiseAlertJson({
      path: 'test.persistence.alarm',
      priority: 'alarm',
      message: 'Persistence test alert',
      group: 'test'
    })
    persistedAlertId = alert.id
    expect(alert.state).toBe('unacknowledged')
  })

  it('should stop the server', async () => {
    await managed.stop()
  })

  it('should restart and find the alert still present', async () => {
    managed = await startServerFromConfig(configDir)
    client = new AlertClient(managed.host)

    const alert = await client.getAlertJson(persistedAlertId)
    expect(alert.id).toBe(persistedAlertId)
    expect(alert.priority).toBe('alarm')
    expect(alert.message).toBe('Persistence test alert')
    expect(alert.state).toBe('unacknowledged')
  })

  it('should have history entries that survived the restart', async () => {
    const history = await client.getHistoryJson({ alertId: persistedAlertId })
    expect(history.total).toBeGreaterThan(0)

    const raiseEntry = history.entries.find((e) => e.eventType === 'raise')
    expect(raiseEntry).toBeDefined()
    expect(raiseEntry?.alertId).toBe(persistedAlertId)
  })

  it('should clean up after persistence tests', async () => {
    await managed.stop()
  })
})
