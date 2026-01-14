/**
 * Alert Manager
 *
 * Orchestrates alert lifecycle operations and coordinates between
 * the state machine, escalation timer, and persistence layer.
 *
 * @see docs/SPEC.md for full specification
 */

import { EventEmitter } from 'events'
import type { Alert, AlertFilter, AlertPriority, IAlertStore, IndicationState } from '../types.js'
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
  private stopped = false

  /**
   * Index mapping sourceId+message to alertId for duplicate detection.
   */
  private alertIndex = new Map<string, string>()

  constructor(config: AlertManagerConfig, timerFunctions?: TimerFunctions, store?: IAlertStore) {
    super()
    this.config = config
    this.store = store
    this.escalationTimer = new EscalationTimer(
      config.escalation,
      (event) => {
        this.handleEscalation(event.alertId)
      },
      timerFunctions
    )
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
      this.emitEvent('cleared', alert, result.previousState)
    } else if (result.alert) {
      this.alerts.set(alertId, result.alert)
      if (this.store) {
        await this.store.update(result.alert)
      }
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

    this.emitEvent('silenced', silenced)

    return silenced
  }

  /**
   * Silence all active alerts.
   */
  silenceAll(): void {
    for (const alert of this.alerts.values()) {
      if (AlertStateMachine.isUnacknowledged(alert)) {
        const duration = this.getDefaultSilenceDuration(alert.priority)
        const until = new Date(Date.now() + duration)
        const silenced = this.stateMachine.silence(alert, until)
        this.alerts.set(alert.id, silenced)
      }
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
      this.emitEvent('cleared', alert, result.previousState)
    } else if (result.alert) {
      this.alerts.set(alertId, result.alert)
      if (this.store) {
        await this.store.update(result.alert)
      }
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
   * Stop the alert manager and clean up resources.
   */
  stop(): void {
    this.stopped = true
    this.escalationTimer.stop()
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

    // Escalate from warning to alarm
    const escalated: Alert = {
      ...alert,
      priority: 'alarm'
    }

    this.alerts.set(alertId, escalated)
    this.emitEvent('escalated', escalated, alert.state)
  }

  /**
   * Update an existing alert with new data.
   */
  private async updateExistingAlert(existing: Alert, params: CreateAlertParams): Promise<Alert> {
    const updated: Alert = {
      ...existing,
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
}
