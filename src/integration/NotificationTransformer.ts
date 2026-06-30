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
      const updateSource = (update as Record<string, unknown>).$source as string | undefined
      const updateSourceObj = (update as Record<string, unknown>).source as
        | Record<string, unknown>
        | undefined
      for (const pv of update.values) {
        const path = String(pv.path)
        if (!path.startsWith('notifications.')) {
          continue
        }
        this.enqueueOperation(path, () =>
          this.handleNotificationValue(
            path,
            pv.value as Notification | null,
            updateSource,
            updateSourceObj
          )
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

  private async handleNotificationValue(
    path: string,
    value: Notification | null,
    $source?: string,
    source?: Record<string, unknown>
  ): Promise<void> {
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

    // If we already track an active alert for this path, check whether
    // priority or message changed — if so, re-raise to let AlertManager
    // handle escalation. Otherwise just heartbeat for source liveness.
    const existingAlertId = this.pathToAlertId.get(path)
    if (existingAlertId) {
      const existingAlert = this.deps.alertManager.getAlert(existingAlertId)
      if (existingAlert) {
        if (existingAlert.priority === priority && existingAlert.message === value.message) {
          this.deps.alertManager.sourceHeartbeat($source ?? 'notifications')
          return
        }
        // Priority or message changed — fall through to re-raise
      } else {
        // Alert was cleared externally — fall through to re-raise
        this.pathToAlertId.delete(path)
      }
    }

    // Strip "notifications." prefix — it's a tree location, not identity
    const alertPath = path.startsWith('notifications.') ? path.slice('notifications.'.length) : path
    const group = this.extractGroup(path)

    const alert = await this.deps.alertManager.raiseAlert({
      path: alertPath,
      $source: $source ?? 'notifications',
      source,
      priority,
      message: value.message,
      group
    })
    this.pathToAlertId.set(path, alert.id)
  }

  private async clearForPath(path: string): Promise<void> {
    const alertId = this.pathToAlertId.get(path)
    if (!alertId) {
      return
    }

    this.pathToAlertId.delete(path)
    try {
      await this.deps.alertManager.clearCondition(alertId)
    } catch {
      // Alert may have been cleared via another path (REST API, delta, etc.)
    }
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
   * Extract the grouping from a notification path.
   * e.g., 'notifications.engine.overheating' → 'engine'
   */
  private extractGroup(path: string): string | undefined {
    const segments = path.split('.')
    // segments[0] = 'notifications', segments[1] = group
    return segments.length > 1 ? segments[1] : undefined
  }
}
