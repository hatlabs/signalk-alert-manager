/**
 * Alert Manager
 *
 * Orchestrates alert lifecycle operations and coordinates between
 * the state machine, escalation timer, and persistence layer.
 *
 * @see docs/SPEC.md for full specification
 */

import { EventEmitter } from 'events'
import type {
  Alert,
  AlertFilter,
  AlertPriority,
  HistoryEventType,
  IAlertStore,
  IHistoryStore
} from '../types.js'
import {
  AlertStateMachine,
  createAlert,
  type CreateAlertParams,
  type StateTransitionResult
} from './AlertStateMachine.js'
import {
  EscalationTimer,
  type EscalationTimerConfig,
  type TimerFunctions
} from './EscalationTimer.js'

/**
 * Configuration for the AlertManager.
 */
export interface AlertManagerConfig {
  /** Escalation settings for priority promotion */
  escalation: EscalationTimerConfig
  /** Silencing duration limits */
  silencing: {
    /** Maximum seconds a non-emergency alert can be silenced */
    defaultMaxSilenceSeconds: number
    /** Maximum seconds an emergency can be silenced */
    emergencyMaxSilenceSeconds: number
  }
  /** Source timeout settings */
  sourceTimeout: {
    /** Seconds before marking alert as stale if source stops updating */
    markStaleAfterSeconds: number
  }
  /** Days to retain alert history (used for pruning on startup) */
  retentionDays?: number
}

/**
 * Event types emitted by the AlertManager.
 */
export type AlertEventType =
  | 'raised'
  | 'acknowledged'
  | 'silenced'
  | 'unsilenced'
  | 'cleared'
  | 'escalated'
  | 'updated'

/**
 * Event emitted when an alert changes.
 */
export interface AlertEvent {
  /** Type of event that occurred */
  type: AlertEventType
  /** The alert at the time of the event */
  alert: Alert
  /** The alert state before the event */
  previousState?: string
}

/**
 * Priority ordering for comparison (higher number = higher priority).
 */
const PRIORITY_ORDER: Record<AlertPriority, number> = {
  caution: 0,
  warning: 1,
  alarm: 2,
  emergency: 3
}

/**
 * Alert Manager
 *
 * Manages the lifecycle of alerts including creation, acknowledgment,
 * silencing, and clearing. Coordinates with the EscalationTimer for
 * automatic priority promotion and optionally persists to an IAlertStore.
 */
export class AlertManager extends EventEmitter {
  private config: AlertManagerConfig
  private alerts = new Map<string, Alert>()
  private stateMachine = new AlertStateMachine()
  private escalationTimer: EscalationTimer
  private store?: IAlertStore
  private historyStore?: IHistoryStore
  private stopped = false
  private timerFns: TimerFunctions

  /**
   * Index mapping path(+context) to alertId for duplicate detection.
   */
  private alertIndex = new Map<string, string>()

  /**
   * Timers for silence expiration.
   */
  private silenceTimers = new Map<string, unknown>()

  constructor(
    config: AlertManagerConfig,
    timerFunctions?: TimerFunctions,
    store?: IAlertStore,
    historyStore?: IHistoryStore
  ) {
    super()
    this.config = config
    this.store = store
    this.historyStore = historyStore
    this.timerFns = timerFunctions ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>)
      }
    }
    this.escalationTimer = new EscalationTimer(
      config.escalation,
      (event) => {
        this.handleEscalation(event.alertId)
      },
      timerFunctions
    )
  }

  /**
   * Load alerts from the store into memory.
   * Call this after construction to restore persisted alerts.
   */
  async loadFromStore(): Promise<void> {
    // Prune old history entries on startup
    if (this.historyStore && this.config.retentionDays !== undefined) {
      this.historyStore.prune(this.config.retentionDays).catch((err: unknown) => {
        console.warn('History pruning failed:', err)
      })
    }

    if (!this.store) {
      return
    }

    let alerts: Alert[]
    try {
      alerts = await this.store.getAll()
    } catch (err) {
      // Fail loudly: an unreadable store must surface as a startup failure
      // rather than silently presenting zero active alerts as truth.
      console.error('Failed to load alerts from store:', err)
      throw err
    }

    for (const alert of alerts) {
      // Store in memory
      this.alerts.set(alert.id, alert)

      // Rebuild alert index for duplicate detection
      const indexKey = this.getIndexKey(alert.path, alert.context)
      this.alertIndex.set(indexKey, alert.id)

      // Start escalation timer for unacknowledged warnings (accounting for elapsed time).
      // Known limitation: reactivated warnings preserve the original raisedAt, so after
      // a server restart they may escalate immediately if enough time has passed since
      // the original raise. The window is small (requires restart while a reactivated
      // warning is still unacknowledged).
      if (alert.state === 'unacknowledged' && alert.priority === 'warning') {
        const elapsedMs = Date.now() - new Date(alert.raisedAt).getTime()
        const remainingMs = this.config.escalation.timeoutSeconds * 1000 - elapsedMs
        this.escalationTimer.startTimer(alert.id, alert.priority, remainingMs)
      }

      // Handle silenced alerts
      if (alert.silenced && alert.silencedUntil) {
        const remainingMs = new Date(alert.silencedUntil).getTime() - Date.now()

        if (remainingMs <= 0) {
          // Silence has expired - unsilence immediately
          const unsilenced = this.stateMachine.unsilence(alert)
          this.alerts.set(alert.id, unsilenced)

          // Persist the unsilenced state
          await this.store.update(unsilenced)

          this.logHistory('unsilence', unsilenced)

          // Emit event for consistency with manual unsilence path
          this.emitEvent('unsilenced', unsilenced)
        } else {
          // Start timer for remaining silence duration
          this.startSilenceExpirationTimer(alert.id, remainingMs)
        }
      }
    }
  }

  /**
   * Raise a new alert or update an existing one.
   *
   * If an active alert with the same path (and context) already exists,
   * it is updated rather than creating a duplicate.
   */
  async raiseAlert(params: CreateAlertParams): Promise<Alert> {
    // Check for existing alert with same path (+context)
    const indexKey = this.getIndexKey(params.path, params.context)
    const existingId = this.alertIndex.get(indexKey)

    if (existingId) {
      const existing = this.alerts.get(existingId)
      if (existing) {
        return this.updateExistingAlert(existing, params)
      }
    }

    // Create new alert
    const alert = createAlert(params)

    // Store in memory
    this.alerts.set(alert.id, alert)
    this.alertIndex.set(indexKey, alert.id)

    // Persist if store available
    if (this.store) {
      await this.store.save(alert)
    }

    // Start escalation timer for warnings
    this.escalationTimer.startTimer(alert.id, alert.priority)

    // Log history (include alert snapshot for history view)
    this.logHistory('raise', alert, {
      newState: alert.state,
      details: { message: alert.message, priority: alert.priority, group: alert.group }
    })

    // Emit event
    this.emitEvent('raised', alert)

    return alert
  }

  /**
   * Acknowledge an alert.
   */
  async acknowledgeAlert(alertId: string, userId?: string): Promise<StateTransitionResult> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    const result = this.stateMachine.acknowledge(alert, userId)

    this.escalationTimer.cancelTimer(alertId)
    if (result.alert) {
      result.alert = this.clearSilencingIfSuperseded(alertId, result.alert)
    }

    if (result.cleared) {
      await this.removeAlert(alertId, alert)
      this.logHistory('clear', alert, {
        userId,
        previousState: result.previousState,
        newState: 'normal',
        details: { message: alert.message, priority: alert.priority, group: alert.group }
      })
      this.emitEvent('cleared', alert, result.previousState)
      return result
    }

    if (result.alert) {
      this.alerts.set(alertId, result.alert)
      if (this.store) {
        await this.store.update(result.alert)
      }
      this.logHistory('acknowledge', result.alert, {
        userId,
        previousState: result.previousState,
        newState: result.alert.state
      })
      this.emitEvent('acknowledged', result.alert, result.previousState)
    }

    return result
  }

  /**
   * Escalate an alert to a higher priority.
   *
   * Only escalation (raising priority) is supported — de-escalation is
   * intentionally not allowed. If the condition has improved, the source
   * should clear and re-raise at the lower priority instead.
   */
  async escalateAlert(alertId: string, newPriority: AlertPriority): Promise<Alert> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    if (PRIORITY_ORDER[newPriority] <= PRIORITY_ORDER[alert.priority]) {
      throw new Error(
        `Cannot escalate from ${alert.priority} to ${newPriority}: new priority must be higher`
      )
    }

    const previousPriority = alert.priority

    // Cancel any existing escalation timer
    this.escalationTimer.cancelTimer(alertId)

    const now = new Date().toISOString()
    const priorityUpdated: Alert = {
      ...alert,
      priority: newPriority,
      lastSourceUpdate: now
    }

    // Reactivate acknowledged/rtn-unacknowledged alerts so the operator
    // is re-alerted at the new (higher) priority.
    const reactivation = this.stateMachine.reactivate(priorityUpdated)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- reactivate() never clears
    const reactivated = reactivation.alert!
    // Escalation is itself a state change (IEC 62923-1 6.4.2.2), so the
    // escalated alert rises within its new priority group.
    const updated: Alert = {
      ...this.clearSilencingIfSuperseded(alertId, reactivated),
      stateChangedAt: now
    }

    this.alerts.set(alertId, updated)
    if (this.store) {
      await this.store.update(updated)
    }

    // Start escalation timer for the new priority level (e.g. caution->warning)
    this.escalationTimer.startTimer(alertId, newPriority)

    this.logHistory('escalate', updated, {
      previousPriority,
      newPriority
    })
    this.emitEvent('escalated', updated, alert.state)

    return updated
  }

  /**
   * Silence an alert.
   *
   * @param alertId - The alert ID to silence
   * @param durationMs - Duration in milliseconds (uses default from config if not specified)
   */
  async silenceAlert(alertId: string, durationMs?: number): Promise<Alert> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    // Determine duration based on priority
    const duration = durationMs ?? this.getDefaultSilenceDuration(alert.priority)
    const until = new Date(Date.now() + duration)

    const silenced = this.stateMachine.silence(alert, until)
    this.alerts.set(alertId, silenced)

    if (this.store) {
      await this.store.update(silenced)
    }

    // Start silence expiration timer
    this.startSilenceExpirationTimer(alertId, duration)

    this.logHistory('silence', silenced, {
      details: { silencedUntil: silenced.silencedUntil }
    })

    this.emitEvent('silenced', silenced)

    return silenced
  }

  /**
   * Unsilence an alert.
   */
  async unsilenceAlert(alertId: string): Promise<Alert> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    // Cancel any pending silence expiration timer
    this.cancelSilenceExpirationTimer(alertId)

    const unsilenced = this.stateMachine.unsilence(alert)
    this.alerts.set(alertId, unsilenced)

    if (this.store) {
      await this.store.update(unsilenced)
    }

    this.logHistory('unsilence', unsilenced)

    this.emitEvent('unsilenced', unsilenced)

    return unsilenced
  }

  /**
   * Silence all unacknowledged alerts.
   */
  async silenceAll(): Promise<void> {
    const toSilence: Alert[] = []

    for (const alert of this.alerts.values()) {
      if (AlertStateMachine.isUnacknowledged(alert) && !alert.silenced) {
        toSilence.push(alert)
      }
    }

    for (const alert of toSilence) {
      const duration = this.getDefaultSilenceDuration(alert.priority)
      const until = new Date(Date.now() + duration)
      const silenced = this.stateMachine.silence(alert, until)
      this.alerts.set(alert.id, silenced)

      if (this.store) {
        await this.store.update(silenced)
      }

      this.startSilenceExpirationTimer(alert.id, duration)
      this.logHistory('silence', silenced, {
        details: { silencedUntil: silenced.silencedUntil }
      })
      this.emitEvent('silenced', silenced)
    }
  }

  /**
   * Clear the condition for an alert.
   */
  async clearCondition(alertId: string): Promise<StateTransitionResult> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    const result = this.stateMachine.clearCondition(alert)

    // Cancel escalation timer when condition clears
    this.escalationTimer.cancelTimer(alertId)

    if (result.cleared) {
      await this.removeAlert(alertId, alert)
      this.logHistory('clear', alert, {
        previousState: result.previousState,
        newState: 'normal',
        details: { message: alert.message, priority: alert.priority, group: alert.group }
      })
      this.emitEvent('cleared', alert, result.previousState)
    } else if (result.alert) {
      this.alerts.set(alertId, result.alert)
      if (this.store) {
        await this.store.update(result.alert)
      }
      this.logHistory('clear', result.alert, {
        previousState: result.previousState,
        newState: result.alert.state,
        details: {
          message: result.alert.message,
          priority: result.alert.priority,
          group: result.alert.group
        }
      })
      this.emitEvent('updated', result.alert, result.previousState)
    }

    return result
  }

  /**
   * Get an alert by ID.
   */
  getAlert(alertId: string): Alert | null {
    return this.alerts.get(alertId) ?? null
  }

  /**
   * Get all alerts, optionally filtered.
   */
  getAlerts(filter?: AlertFilter): Alert[] {
    let alerts = Array.from(this.alerts.values())

    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state]
      alerts = alerts.filter((a) => states.includes(a.state))
    }

    if (filter?.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
      alerts = alerts.filter((a) => priorities.includes(a.priority))
    }

    if (filter?.group) {
      alerts = alerts.filter((a) => a.group === filter.group)
    }

    if (filter?.stale !== undefined) {
      alerts = alerts.filter((a) => a.stale === filter.stale)
    }

    return alerts
  }

  /**
   * Get count of active alerts.
   */
  getActiveAlertCount(): number {
    return this.alerts.size
  }

  /**
   * Get count of unacknowledged alerts.
   */
  getUnacknowledgedCount(): number {
    return this.getAlerts({ state: ['unacknowledged', 'rtn-unacknowledged'] }).length
  }

  /**
   * Update last seen timestamp for a source.
   * Called when a heartbeat is received from a source.
   */
  sourceHeartbeat($source: string): void {
    const now = new Date().toISOString()

    for (const alert of this.alerts.values()) {
      if (alert.$source === $source) {
        const updated = {
          ...alert,
          lastSourceUpdate: now,
          sourceOnline: true
        }
        this.alerts.set(alert.id, updated)
      }
    }
  }

  /**
   * Mark all alerts from a source as stale.
   * Called when a source goes offline.
   */
  markSourceOffline($source: string): void {
    for (const alert of this.alerts.values()) {
      if (alert.$source === $source) {
        const updated = {
          ...alert,
          stale: true,
          sourceOnline: false
        }
        this.alerts.set(alert.id, updated)
      }
    }
  }

  /**
   * Clear the stale flag for an alert.
   * Called by operators to acknowledge that a stale alert has been reviewed.
   */
  async clearStaleFlag(alertId: string): Promise<Alert> {
    const alert = this.alerts.get(alertId)
    if (!alert) {
      throw new Error('Alert not found')
    }

    const updated: Alert = {
      ...alert,
      stale: false
    }

    this.alerts.set(alertId, updated)

    if (this.store) {
      await this.store.update(updated)
    }

    this.emitEvent('updated', updated)

    return updated
  }

  /**
   * Stop the alert manager and clean up resources.
   */
  stop(): void {
    this.stopped = true
    this.escalationTimer.stop()

    // Cancel all silence expiration timers
    for (const handle of this.silenceTimers.values()) {
      this.timerFns.clearTimeout(handle)
    }
    this.silenceTimers.clear()
  }

  /**
   * Handle escalation timer callback.
   */
  private handleEscalation(alertId: string): void {
    if (this.stopped) {
      return
    }

    const alert = this.alerts.get(alertId)
    if (!alert) {
      return
    }

    const previousPriority = alert.priority

    // Escalate from warning to alarm. Escalation is itself a state change
    // (IEC 62923-1 6.4.2.2), so the alarm rises within its priority group.
    const escalated: Alert = {
      ...alert,
      priority: 'alarm',
      stateChangedAt: new Date().toISOString()
    }

    this.alerts.set(alertId, escalated)

    // Persist escalation to store
    if (this.store) {
      this.store.update(escalated).catch((err: unknown) => {
        // Log but don't fail - escalation already applied in memory
        console.error(`Failed to persist escalation for alert ${alertId}:`, err)
      })
    }

    this.logHistory('escalate', escalated, {
      previousPriority,
      newPriority: 'alarm'
    })

    this.emitEvent('escalated', escalated, alert.state)
  }

  /**
   * Update an existing alert with new data.
   * Priority can only be escalated (increased), not reduced.
   * If the alert was acknowledged or returned-to-normal, reactivates it.
   */
  private async updateExistingAlert(existing: Alert, params: CreateAlertParams): Promise<Alert> {
    // Allow priority escalation but not reduction
    const newPriority =
      PRIORITY_ORDER[params.priority] > PRIORITY_ORDER[existing.priority]
        ? params.priority
        : existing.priority

    // If priority is being escalated, cancel any existing escalation timer
    if (newPriority !== existing.priority) {
      this.escalationTimer.cancelTimer(existing.id)
    }

    const dataUpdated: Alert = {
      ...existing,
      $source: params.$source,
      source: params.source ?? existing.source,
      priority: newPriority,
      message: params.message,
      data: params.data,
      lastSourceUpdate: new Date().toISOString(),
      sourceOnline: true
    }

    // Attempt to reactivate (acknowledged/rtn-unacknowledged → unacknowledged)
    const reactivation = this.stateMachine.reactivate(dataUpdated)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- reactivate() never clears
    const updated = this.clearSilencingIfSuperseded(existing.id, reactivation.alert!)
    const stateChanged = reactivation.previousState !== updated.state

    this.alerts.set(existing.id, updated)

    if (this.store) {
      await this.store.update(updated)
    }

    if (newPriority !== existing.priority) {
      this.logHistory('escalate', updated, {
        previousPriority: existing.priority,
        newPriority
      })
    }

    if (stateChanged) {
      // Reactivation: restart escalation, log and emit 'raised'
      this.escalationTimer.cancelTimer(existing.id)
      this.escalationTimer.startTimer(existing.id, updated.priority)

      this.logHistory('raise', updated, {
        previousState: reactivation.previousState,
        newState: updated.state,
        details: {
          message: updated.message,
          priority: updated.priority,
          group: updated.group
        }
      })
      this.emitEvent('raised', updated, reactivation.previousState)
    } else {
      this.emitEvent('updated', updated)
    }

    return updated
  }

  /**
   * Remove an alert from storage.
   */
  private async removeAlert(alertId: string, alert: Alert): Promise<void> {
    this.alerts.delete(alertId)
    this.alertIndex.delete(this.getIndexKey(alert.path, alert.context))

    // Cancel any pending silence expiration timer
    this.cancelSilenceExpirationTimer(alertId)

    if (this.store) {
      await this.store.delete(alertId)
    }
  }

  private getIndexKey(path: string, context?: string): string {
    return context ? `${context}::${path}` : path
  }

  /**
   * Get default silence duration based on priority.
   */
  private getDefaultSilenceDuration(priority: AlertPriority): number {
    if (priority === 'emergency') {
      return this.config.silencing.emergencyMaxSilenceSeconds * 1000
    }
    return this.config.silencing.defaultMaxSilenceSeconds * 1000
  }

  /**
   * Log a history event (fire-and-forget).
   */
  private logHistory(
    eventType: HistoryEventType,
    alert: Alert,
    extra?: {
      userId?: string
      previousState?: string
      newState?: string
      previousPriority?: AlertPriority
      newPriority?: AlertPriority
      details?: Record<string, unknown>
    }
  ): void {
    this.historyStore
      ?.log({
        alertId: alert.id,
        eventType,
        timestamp: new Date().toISOString(),
        userId: extra?.userId,
        previousState: extra?.previousState as Alert['state'],
        newState: extra?.newState as Alert['state'],
        previousPriority: extra?.previousPriority,
        newPriority: extra?.newPriority,
        details: extra?.details
      })
      .catch((err: unknown) => {
        console.warn('History logging failed:', err)
      })
  }

  /**
   * Emit an alert event.
   */
  private emitEvent(type: AlertEventType, alert: Alert, previousState?: string): void {
    if (this.stopped) {
      return
    }

    const event: AlertEvent = {
      type,
      alert,
      previousState
    }

    this.emit('alert', event)
  }

  /**
   * Clear silencing if the current operation supersedes it.
   *
   * Silencing suppresses audio — it is superseded when the operator has
   * attended to the alert (acknowledge) or when the system demands renewed
   * attention (reactivation, escalation). This is the single place that
   * encodes that rule, replacing previously scattered cleanup in
   * acknowledgeAlert, escalateAlert, and updateExistingAlert.
   *
   * Does not emit a separate 'unsilenced' event because the caller's own
   * event (acknowledged, escalated, raised) already conveys that the
   * operator's attention has been (re)demanded.
   */
  private clearSilencingIfSuperseded(alertId: string, alert: Alert): Alert {
    if (!alert.silenced) {
      return alert
    }
    this.cancelSilenceExpirationTimer(alertId)
    return this.stateMachine.unsilence(alert)
  }

  /**
   * Start a timer to automatically unsilence an alert after duration expires.
   */
  private startSilenceExpirationTimer(alertId: string, durationMs: number): void {
    // Cancel any existing timer for this alert
    this.cancelSilenceExpirationTimer(alertId)

    const handle = this.timerFns.setTimeout(() => {
      this.handleSilenceExpiration(alertId)
    }, durationMs)

    this.silenceTimers.set(alertId, handle)
  }

  /**
   * Cancel the silence expiration timer for an alert.
   */
  private cancelSilenceExpirationTimer(alertId: string): void {
    const handle = this.silenceTimers.get(alertId)
    if (handle !== undefined) {
      this.timerFns.clearTimeout(handle)
      this.silenceTimers.delete(alertId)
    }
  }

  /**
   * Handle silence expiration - automatically unsilence the alert.
   */
  private handleSilenceExpiration(alertId: string): void {
    this.silenceTimers.delete(alertId)

    if (this.stopped) {
      return
    }

    const alert = this.alerts.get(alertId)
    if (!alert?.silenced) {
      return
    }

    const unsilenced = this.stateMachine.unsilence(alert)
    this.alerts.set(alertId, unsilenced)

    // Persist to store
    if (this.store) {
      this.store.update(unsilenced).catch((err: unknown) => {
        // Log but don't fail - unsilence already applied in memory
        console.error(`Failed to persist unsilence for alert ${alertId}:`, err)
      })
    }

    this.logHistory('unsilence', unsilenced)

    this.emitEvent('unsilenced', unsilenced)
  }
}
