/**
 * Signal K PUT Handler Tests
 *
 * Tests for PUT handlers that expose alert actions via the SK data model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ActionHandler, ActionResult, ServerAPI } from '@signalk/server-api'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import { registerPutHandlers } from '../../src/api/putHandlers.js'

const DEFAULT_CONFIG: AlertManagerConfig = {
  escalation: { enabled: false, timeoutSeconds: 300 },
  silencing: { defaultMaxSilenceSeconds: 120, emergencyMaxSilenceSeconds: 30 },
  sourceTimeout: { markStaleAfterSeconds: 60 },
  retentionDays: 90
}

/**
 * Captures registered PUT handlers for testing.
 */
function createMockApp(): {
  app: Pick<ServerAPI, 'registerPutHandler'>
  handlers: Map<string, ActionHandler>
} {
  const handlers = new Map<string, ActionHandler>()
  const app = {
    registerPutHandler: (_context: string, path: string, callback: ActionHandler) => {
      handlers.set(path, callback)
    }
  }
  return { app: app as unknown as ServerAPI, handlers }
}

function callHandler(
  handler: ActionHandler,
  value: unknown
): ActionResult | { state: 'PENDING'; callback: Promise<ActionResult> } {
  let resolveCallback: ((r: ActionResult) => void) | undefined
  const callbackPromise = new Promise<ActionResult>((resolve) => {
    resolveCallback = resolve
  })

  const result = handler('vessels.self', 'test.path', value, (r: ActionResult) => {
    resolveCallback?.(r)
  })

  if (result.state === 'PENDING') {
    return { state: 'PENDING', callback: callbackPromise }
  }
  return result
}

async function callAsyncHandler(handler: ActionHandler, value: unknown): Promise<ActionResult> {
  const result = callHandler(handler, value)
  if ('callback' in result) {
    return result.callback
  }
  return result
}

function getHandler(handlers: Map<string, ActionHandler>, path: string): ActionHandler {
  const handler = handlers.get(path)
  if (!handler) {
    throw new Error(`Handler not found for path: ${path}`)
  }
  return handler
}

describe('PUT Handlers', () => {
  let manager: AlertManager
  let handlers: Map<string, ActionHandler>

  beforeEach(() => {
    manager = new AlertManager(DEFAULT_CONFIG)
    const { app, handlers: h } = createMockApp()
    handlers = h
    registerPutHandlers(app, { getAlertManager: () => manager })
  })

  afterEach(() => {
    manager.stop()
  })

  it('should register all expected handlers', () => {
    expect(handlers.has('alerts.actions.silenceAll')).toBe(true)
    expect(handlers.has('alerts.actions.silence')).toBe(true)
    expect(handlers.has('alerts.actions.acknowledge')).toBe(true)
    expect(handlers.has('alerts.actions.clearCondition')).toBe(true)
    expect(handlers.has('alerts.actions.escalate')).toBe(true)
  })

  describe('silenceAll', () => {
    it('should silence all unacknowledged alerts', async () => {
      const alert1 = await manager.raiseAlert({
        path: 'test.alert1',
        $source: 'test',
        priority: 'alarm',
        message: 'Alert 1'
      })
      const alert2 = await manager.raiseAlert({
        path: 'test.alert2',
        $source: 'test',
        priority: 'warning',
        message: 'Alert 2'
      })

      const handler = getHandler(handlers, 'alerts.actions.silenceAll')
      const result = await callAsyncHandler(handler, {})

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
      expect(manager.getAlert(alert1.id)?.silenced).toBe(true)
      expect(manager.getAlert(alert2.id)?.silenced).toBe(true)
    })

    it('should succeed even with no alerts', async () => {
      const handler = getHandler(handlers, 'alerts.actions.silenceAll')
      const result = await callAsyncHandler(handler, {})

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
    })
  })

  describe('silence', () => {
    it('should silence a specific alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'alarm',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.silence')
      const result = await callAsyncHandler(handler, { id: alert.id })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
      expect(manager.getAlert(alert.id)?.silenced).toBe(true)
    })

    it('should return 400 for missing id', async () => {
      const handler = getHandler(handlers, 'alerts.actions.silence')
      const result = await callAsyncHandler(handler, {})

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(400)
      expect(result.message).toContain('id')
    })

    it('should return 400 for non-existent alert', async () => {
      const handler = getHandler(handlers, 'alerts.actions.silence')
      const result = await callAsyncHandler(handler, { id: 'non-existent' })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(400)
      expect(result.message).toContain('not found')
    })
  })

  describe('acknowledge', () => {
    it('should acknowledge a specific alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'alarm',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.acknowledge')
      const result = await callAsyncHandler(handler, { id: alert.id })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
      expect(manager.getAlert(alert.id)?.state).toBe('acknowledged')
    })

    it('should return 400 for missing id', async () => {
      const handler = getHandler(handlers, 'alerts.actions.acknowledge')
      const result = await callAsyncHandler(handler, { id: '' })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(400)
    })
  })

  describe('clearCondition', () => {
    it('should clear condition on a specific alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'alarm',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.clearCondition')
      const result = await callAsyncHandler(handler, { id: alert.id })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
      // Alarm priority requires ack, so clearing goes to rtn-unacknowledged
      expect(manager.getAlert(alert.id)?.state).toBe('rtn-unacknowledged')
    })
  })

  describe('escalate', () => {
    it('should escalate a specific alert', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'warning',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.escalate')
      const result = await callAsyncHandler(handler, {
        id: alert.id,
        priority: 'alarm'
      })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(200)
      expect(manager.getAlert(alert.id)?.priority).toBe('alarm')
    })

    it('should return 400 for missing priority', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'warning',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.escalate')
      const result = await callAsyncHandler(handler, { id: alert.id })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(400)
      expect(result.message).toContain('priority')
    })

    it('should return 400 for invalid priority', async () => {
      const alert = await manager.raiseAlert({
        path: 'test.alert',
        $source: 'test',
        priority: 'warning',
        message: 'Test alert'
      })

      const handler = getHandler(handlers, 'alerts.actions.escalate')
      const result = await callAsyncHandler(handler, {
        id: alert.id,
        priority: 'invalid'
      })

      expect(result.state).toBe('COMPLETED')
      expect(result.statusCode).toBe(400)
      expect(result.message).toContain('Invalid priority')
    })
  })

  describe('uninitialized manager', () => {
    it('should return 400 when manager is not initialized', () => {
      const { app: mockApp, handlers: uninitHandlers } = createMockApp()
      registerPutHandlers(mockApp, { getAlertManager: () => undefined })

      const handler = getHandler(uninitHandlers, 'alerts.actions.silenceAll')
      const result = callHandler(handler, {})

      expect(result.state).toBe('COMPLETED')
      expect((result as ActionResult).statusCode).toBe(400)
      expect((result as ActionResult).message).toContain('not initialized')
    })
  })
})
