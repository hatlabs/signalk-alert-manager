/**
 * Signal K PUT Handlers
 *
 * Registers PUT handlers for alert actions on the Signal K data model.
 * This provides an alternative to the REST API that works with readwrite
 * auth tokens (the REST API under /plugins requires admin auth).
 *
 * PUT handlers are the standard Signal K mechanism for plugins to expose
 * actions. They work over both HTTP PUT to /signalk/v1/api/vessels/self/<path>
 * and WebSocket PUT messages.
 *
 * @see https://signalk.org/specification/ for PUT handler documentation
 */

import type { ActionHandler, ActionResult, ServerAPI } from '@signalk/server-api'
import type { AlertManager } from '../core/AlertManager.js'
import type { AlertPriority } from '../types.js'

const VALID_PRIORITIES: AlertPriority[] = ['emergency', 'alarm', 'warning', 'caution']

interface PutHandlerDependencies {
  getAlertManager(): AlertManager | undefined
}

function managerOrFail(deps: PutHandlerDependencies): AlertManager {
  const mgr = deps.getAlertManager()
  if (!mgr) {
    throw new Error('Alert manager not initialized')
  }
  return mgr
}

function extractId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('id' in value)) {
    throw new Error('Missing required field: id')
  }
  const id = (value as Record<string, unknown>).id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Field id must be a non-empty string')
  }
  return id
}

function completed(statusCode: number, message?: string): ActionResult {
  return { state: 'COMPLETED', statusCode, message }
}

function makeAsyncHandler(
  deps: PutHandlerDependencies,
  fn: (mgr: AlertManager, value: unknown) => Promise<void>
): ActionHandler {
  return (_context: string, _path: string, value: unknown, callback) => {
    try {
      const mgr = managerOrFail(deps)
      fn(mgr, value)
        .then(() => {
          callback(completed(200))
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          callback(completed(400, message))
        })
      return { state: 'PENDING' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return completed(400, message)
    }
  }
}

/**
 * Register Signal K PUT handlers for all alert actions.
 *
 * Handlers are automatically cleaned up when the plugin stops
 * (the SK framework tracks registrations per plugin).
 */
export function registerPutHandlers(app: ServerAPI, deps: PutHandlerDependencies): void {
  const context = 'vessels.self'

  app.registerPutHandler(
    context,
    'alerts.actions.silenceAll',
    makeAsyncHandler(deps, async (mgr) => {
      await mgr.silenceAll()
    })
  )

  app.registerPutHandler(
    context,
    'alerts.actions.silence',
    makeAsyncHandler(deps, async (mgr, value) => {
      const id = extractId(value)
      await mgr.silenceAlert(id)
    })
  )

  app.registerPutHandler(
    context,
    'alerts.actions.acknowledge',
    makeAsyncHandler(deps, async (mgr, value) => {
      const id = extractId(value)
      await mgr.acknowledgeAlert(id)
    })
  )

  app.registerPutHandler(
    context,
    'alerts.actions.clearCondition',
    makeAsyncHandler(deps, async (mgr, value) => {
      const id = extractId(value)
      await mgr.clearCondition(id)
    })
  )

  app.registerPutHandler(
    context,
    'alerts.actions.escalate',
    makeAsyncHandler(deps, async (mgr, value) => {
      const id = extractId(value)
      if (typeof value !== 'object' || value === null || !('priority' in value)) {
        throw new Error('Missing required field: priority')
      }
      const priority = (value as Record<string, unknown>).priority
      if (!VALID_PRIORITIES.includes(priority as AlertPriority)) {
        throw new Error(`Invalid priority: ${String(priority)}`)
      }
      await mgr.escalateAlert(id, priority as AlertPriority)
    })
  )
}
