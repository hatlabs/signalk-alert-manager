/**
 * NotificationTransformer
 *
 * Bridges Signal K notifications to the alert management system by
 * intercepting incoming deltas, extracting notification path values,
 * and translating them to AlertManager raise/clear operations.
 */

import type { Delta, DeltaInputHandler, Notification } from '@signalk/server-api'
import { ALARM_STATE, hasValues } from '@signalk/server-api'
import type { AlertManager, AlertEvent } from '../core/AlertManager.js'
import type { AlertPriority } from '../types.js'

/**
 * Maps Signal K ALARM_STATE to AlertPriority.
 * Normal/nominal states are not mapped — they trigger clearCondition instead.
 */
const STATE_TO_PRIORITY: Partial<Record<string, AlertPriority>> = {
  [ALARM_STATE.emergency]: 'emergency',
  [ALARM_STATE.alarm]: 'alarm',
  [ALARM_STATE.warn]: 'warning',
  // Defensive: some non-conforming sources send "warning" instead of "warn"
  warning: 'warning',
  [ALARM_STATE.alert]: 'caution'
}

/** States that indicate the condition has cleared. */
const CLEAR_STATES = new Set<string>([ALARM_STATE.normal, ALARM_STATE.nominal])

export interface NotificationTransformerDeps {
  alertManager: AlertManager
  registerDeltaInputHandler: (handler: DeltaInputHandler) => void
  debug: (msg: unknown, ...args: unknown[]) => void
}

export class NotificationTransformer {
  private deps: NotificationTransformerDeps
  /** Maps notification path → alert ID for clearCondition lookups. */
  private pathToAlertId = new Map<string, string>()
  /**
   * Per-path promise chain to serialize async raise/clear operations.
   * Prevents race conditions when a rapid raise-then-clear arrives
   * before the raiseAlert promise resolves.
   */
  private pendingOps = new Map<string, Promise<void>>()
  private stopped = false
  private alertEventListener: ((event: AlertEvent) => void) | null = null

  constructor(deps: NotificationTransformerDeps) {
    this.deps = deps
  }

  start(): void {
    this.stopped = false

    this.deps.registerDeltaInputHandler((delta: Delta, next: (delta: Delta) => void) => {
      // Pass through immediately — never block SK processing
      next(delta)
      if (!this.stopped) {
        this.processDelta(delta)
      }
    })

    // Listen for externally-cleared alerts to clean up pathToAlertId
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
      for (const pv of update.values) {
        const path = String(pv.path)
        if (!path.startsWith('notifications.')) {
          continue
        }
        this.enqueueOperation(path, () =>
          this.handleNotificationValue(path, pv.value as Notification | null)
        )
      }
    }
  }

  /**
   * Serialize async operations per notification path to prevent
   * race conditions between raise and clear.
   */
  private enqueueOperation(path: string, op: () => Promise<void>): void {
    const prev = this.pendingOps.get(path) ?? Promise.resolve()
    const next = prev.then(op).catch((err: unknown) => {
      this.deps.debug('Notification operation failed for path', path, err)
    })
    this.pendingOps.set(path, next)
  }

  private async handleNotificationValue(path: string, value: Notification | null): Promise<void> {
    if (this.stopped) {
      return
    }

    // Null value or clear states → clear condition
    if (value === null) {
      await this.clearForPath(path)
      return
    }

    if (typeof value !== 'object' || !('state' in value)) {
      return
    }

    // Cast to string for defensive handling of non-conforming sources
    const stateStr = value.state as string

    if (CLEAR_STATES.has(stateStr)) {
      await this.clearForPath(path)
      return
    }

    const priority = STATE_TO_PRIORITY[stateStr]
    if (priority === undefined) {
      return
    }

    const sourceId = `notifications:${path}`
    // Strip "notifications." prefix — it's a tree location, not identity
    const alertPath = path.startsWith('notifications.') ? path.slice('notifications.'.length) : path
    const category = this.extractCategory(path)

    const alert = await this.deps.alertManager.raiseAlert({
      path: alertPath,
      sourceId,
      priority,
      message: value.message,
      category
    })
    this.pathToAlertId.set(path, alert.id)
  }

  private async clearForPath(path: string): Promise<void> {
    const alertId = this.pathToAlertId.get(path)
    if (!alertId) {
      return
    }

    this.pathToAlertId.delete(path)
    await this.deps.alertManager.clearCondition(alertId)
  }

  /** Remove an alert ID from the path map when cleared externally. */
  private removeAlertIdFromMap(alertId: string): void {
    for (const [path, id] of this.pathToAlertId) {
      if (id === alertId) {
        this.pathToAlertId.delete(path)
        return
      }
    }
  }

  /**
   * Extract category from notification path.
   * e.g., 'notifications.engine.overheating' → 'engine'
   */
  private extractCategory(path: string): string | undefined {
    const segments = path.split('.')
    // segments[0] = 'notifications', segments[1] = category
    return segments.length > 1 ? segments[1] : undefined
  }
}
