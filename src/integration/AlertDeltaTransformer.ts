/**
 * AlertDeltaTransformer
 *
 * Intercepts incoming `alerts.*` deltas and translates them to
 * AlertManager raise/clear operations. This provides a delta-based
 * ingress path for devices that communicate natively via WebSocket.
 *
 * Only "what" fields are extracted from the delta value (priority,
 * message, category, data, latching). Lifecycle fields (id, state,
 * silenced, etc.) are ignored — the AlertManager is authoritative
 * for those.
 *
 * Deltas from the alert manager's own DeltaPublisher are skipped
 * to prevent feedback loops.
 */

import type { Delta, DeltaInputHandler } from '@signalk/server-api'
import { hasValues } from '@signalk/server-api'
import type { AlertManager, AlertEvent } from '../core/AlertManager.js'
import type { AlertPriority } from '../types.js'

const ALERTS_PREFIX = 'alerts.'

/** Source label used by DeltaPublisher — skip these to avoid feedback. */
const OWN_SOURCE_LABEL = 'alert-manager'

const VALID_PRIORITIES = new Set<string>(['emergency', 'alarm', 'warning', 'caution'])

export interface AlertDeltaTransformerDeps {
  alertManager: AlertManager
  registerDeltaInputHandler: (handler: DeltaInputHandler) => void
  debug: (msg: unknown, ...args: unknown[]) => void
}

export class AlertDeltaTransformer {
  private deps: AlertDeltaTransformerDeps
  /** Maps alert path → alert ID for clearCondition lookups. */
  private pathToAlertId = new Map<string, string>()
  private pendingOps = new Map<string, Promise<void>>()
  private stopped = false
  private alertEventListener: ((event: AlertEvent) => void) | null = null

  constructor(deps: AlertDeltaTransformerDeps) {
    this.deps = deps
  }

  start(): void {
    this.stopped = false

    this.deps.registerDeltaInputHandler((delta: Delta, next: (delta: Delta) => void) => {
      next(delta)
      if (!this.stopped) {
        this.processDelta(delta)
      }
    })

    this.alertEventListener = (event: AlertEvent) => {
      if (event.type === 'cleared') {
        this.removeAlertIdFromMap(event.alert.id)
      }
    }
    this.deps.alertManager.on('alert', this.alertEventListener)
  }

  stop(): void {
    this.stopped = true

    if (this.alertEventListener) {
      this.deps.alertManager.removeListener('alert', this.alertEventListener)
      this.alertEventListener = null
    }

    this.pathToAlertId.clear()
    this.pendingOps.clear()
  }

  private processDelta(delta: Delta): void {
    for (const update of delta.updates) {
      if (!hasValues(update)) {
        continue
      }

      const updateRec = update as Record<string, unknown>
      const sourceObj = updateRec.source as Record<string, unknown> | undefined

      // Skip our own published deltas to prevent feedback loops
      if (sourceObj?.label === OWN_SOURCE_LABEL) {
        continue
      }

      const sourceLabel = sourceObj?.label
      const $source =
        (updateRec.$source as string | undefined) ??
        (typeof sourceLabel === 'string' ? sourceLabel : '')

      for (const pv of update.values) {
        const path = String(pv.path)
        if (!path.startsWith(ALERTS_PREFIX)) {
          continue
        }
        this.enqueueOperation(path, () =>
          this.handleAlertValue(
            path,
            pv.value as Record<string, unknown> | null,
            $source,
            sourceObj
          )
        )
      }
    }
  }

  private enqueueOperation(path: string, op: () => Promise<void>): void {
    const prev = this.pendingOps.get(path) ?? Promise.resolve()
    const next = prev.then(op).catch((err: unknown) => {
      this.deps.debug('Alert delta operation failed for path', path, err)
    })
    this.pendingOps.set(path, next)
  }

  private async handleAlertValue(
    deltaPath: string,
    value: Record<string, unknown> | null,
    $source: string,
    source?: Record<string, unknown>
  ): Promise<void> {
    if (this.stopped) {
      return
    }

    const alertPath = deltaPath.slice(ALERTS_PREFIX.length)

    // Null value → clear condition
    if (value === null) {
      await this.clearForPath(deltaPath)
      return
    }

    if (typeof value !== 'object') {
      return
    }

    // state: 'normal' → clear condition
    if (value.state === 'normal') {
      await this.clearForPath(deltaPath)
      return
    }

    // Validate required fields
    const priority = value.priority as string | undefined
    const message = value.message as string | undefined

    if (!priority || !VALID_PRIORITIES.has(priority)) {
      this.deps.debug('Alert delta missing or invalid priority:', deltaPath, priority)
      return
    }
    if (!message || typeof message !== 'string') {
      this.deps.debug('Alert delta missing or invalid message:', deltaPath)
      return
    }

    // Check for existing alert — re-raise only if priority or message changed
    const existingAlertId = this.pathToAlertId.get(deltaPath)
    if (existingAlertId) {
      const existingAlert = this.deps.alertManager.getAlert(existingAlertId)
      if (existingAlert) {
        if (existingAlert.priority !== priority || existingAlert.message !== message) {
          // Changed — fall through to re-raise
        } else {
          this.deps.alertManager.sourceHeartbeat($source || 'delta')
          return
        }
      } else {
        this.pathToAlertId.delete(deltaPath)
      }
    }

    const alert = await this.deps.alertManager.raiseAlert({
      path: alertPath,
      $source: $source || 'delta',
      source,
      priority: priority as AlertPriority,
      message,
      category: typeof value.category === 'string' ? value.category : undefined,
      data:
        value.data && typeof value.data === 'object' && !Array.isArray(value.data)
          ? (value.data as Record<string, unknown>)
          : undefined,
      latching: typeof value.latching === 'boolean' ? value.latching : undefined
    })
    this.pathToAlertId.set(deltaPath, alert.id)
  }

  private async clearForPath(deltaPath: string): Promise<void> {
    const alertId = this.pathToAlertId.get(deltaPath)
    if (!alertId) {
      return
    }

    this.pathToAlertId.delete(deltaPath)
    await this.deps.alertManager.clearCondition(alertId)
  }

  private removeAlertIdFromMap(alertId: string): void {
    for (const [path, id] of this.pathToAlertId) {
      if (id === alertId) {
        this.pathToAlertId.delete(path)
        return
      }
    }
  }
}
