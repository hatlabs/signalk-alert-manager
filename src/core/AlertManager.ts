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
  IHistoryStore,
  IndicationState
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
    /** Maximum seconds an alarm can be silenced */
    alarmMaxSeconds: number
    /** Maximum seconds an emergency can be silenced */
    emergencyMaxSeconds: number
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
  /** The alert after the event (null if cleared) */
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
   * Index mapping sourceId+message to alertId for duplicate detection.
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
      this.historyStore.prune(this.config.retentionDays).catch(() => {
        // Fire-and-forget: pruning failure is non-critical
      })
    }

    if (!this.store) {
      return
    }

    let alerts: Alert[]
    try {
      alerts = await this.store.getAll()
    } catch (err) {
      console.error('Failed to load alerts from store:', err)
      return
    }

    for (const alert of alerts) {
      // Store in memory
      this.alerts.set(alert.id, alert)

      // Rebuild alert index for duplicate detection
      const indexKey = this.getIndexKey(alert.sourceId, alert.message)
      this.alertIndex.set(indexKey, alert.id)

      // Start escalation timer for unacknowledged warnings (accounting for elapsed time)
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
   * If an alert from the same source with the same message already exists,
   * it is updated rather than creating a duplicate.
   */
  async raiseAlert(params: CreateAlertParams): Promise<Alert> {
    // Check for existing alert from same source with same message
    const indexKey = this.getIndexKey(params.sourceId, params.message)
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

    // Log history
    this.logHistory('raise', alert, { newState: alert.state })

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

    // Cancel escalation timer on acknowledge
    this.escalationTimer.cancelTimer(alertId)

    if (result.cleared) {
      await this.removeAlert(alertId, alert)
      this.logHistory('clear', alert, {
        userId,
        previousState: result.previousState
      })
      this.emitEvent('cleared', alert, result.previousState)
    } else if (result.alert) {
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
      this.logHistory('clear', alert, { previousState: result.previousState })
      this.emitEvent('cleared', alert, result.previousState)
    } else if (result.alert) {
      this.alerts.set(alertId, result.alert)
      if (this.store) {
        await this.store.update(result.alert)
      }
      this.logHistory('clear', result.alert, {
        previousState: result.previousState,
        newState: result.alert.state
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

    if (filter?.category) {
      alerts = alerts.filter((a) => a.category === filter.category)
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
   * Get current indication state for hardware integration.
   */
  getIndicationState(): IndicationState {
    const unacknowledged = this.getAlerts({ state: ['unacknowledged', 'rtn-unacknowledged'] })

    if (unacknowledged.length === 0) {
      return {
        audible: false,
        priority: null,
        flash: false,
        silenced: false,
        unacknowledgedCount: 0
      }
    }

    // Find highest priority
    let highestPriority: AlertPriority = 'caution'
    let allSilenced = true

    for (const alert of unacknowledged) {
      if (PRIORITY_ORDER[alert.priority] > PRIORITY_ORDER[highestPriority]) {
        highestPriority = alert.priority
      }
      if (!alert.silenced) {
        allSilenced = false
      }
    }

    return {
      audible: !allSilenced,
      priority: highestPriority,
      flash: true,
      silenced: allSilenced,
      unacknowledgedCount: unacknowledged.length
    }
  }

  /**
   * Update last seen timestamp for a source.
   * Called when a heartbeat is received from a source.
   */
  sourceHeartbeat(sourceId: string): void {
    const now = new Date().toISOString()

    for (const alert of this.alerts.values()) {
      if (alert.sourceId === sourceId) {
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
  markSourceOffline(sourceId: string): void {
    for (const alert of this.alerts.values()) {
      if (alert.sourceId === sourceId) {
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

    // Escalate from warning to alarm
    const escalated: Alert = {
      ...alert,
      priority: 'alarm'
    }

    this.alerts.set(alertId, escalated)

    // Persist escalation to store
    if (this.store) {
      this.store.update(escalated).catch(() => {
        // Log error but don't fail - escalation already applied in memory
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

    const updated: Alert = {
      ...existing,
      priority: newPriority,
      data: params.data,
      lastSourceUpdate: new Date().toISOString(),
      sourceOnline: true
    }

    this.alerts.set(existing.id, updated)

    if (this.store) {
      await this.store.update(updated)
    }

    this.emitEvent('updated', updated)

    return updated
  }

  /**
   * Remove an alert from storage.
   */
  private async removeAlert(alertId: string, alert: Alert): Promise<void> {
    this.alerts.delete(alertId)
    this.alertIndex.delete(this.getIndexKey(alert.sourceId, alert.message))

    // Cancel any pending silence expiration timer
    this.cancelSilenceExpirationTimer(alertId)

    if (this.store) {
      await this.store.delete(alertId)
    }
  }

  /**
   * Get the index key for duplicate detection.
   */
  private getIndexKey(sourceId: string, message: string): string {
    return `${sourceId}:${message}`
  }

  /**
   * Get default silence duration based on priority.
   */
  private getDefaultSilenceDuration(priority: AlertPriority): number {
    if (priority === 'emergency') {
      return this.config.silencing.emergencyMaxSeconds * 1000
    }
    return this.config.silencing.alarmMaxSeconds * 1000
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
      .catch(() => {
        // Fire-and-forget: history logging failure must not affect alert operations
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
      this.store.update(unsilenced).catch(() => {
        // Log error but don't fail - unsilence already applied in memory
      })
    }

    this.logHistory('unsilence', unsilenced)

    this.emitEvent('unsilenced', unsilenced)
  }
}
