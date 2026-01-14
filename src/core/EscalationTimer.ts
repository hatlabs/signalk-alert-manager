/**
 * Escalation Timer
 *
 * Tracks unacknowledged Warning alerts and escalates them to Alarm priority
 * after a configurable timeout.
 *
 * @see docs/SPEC.md Section 2.1 for escalation requirements
 */

import type { AlertPriority } from '../types.js'

/**
 * Opaque handle for timer identification.
 */
export type TimerHandle = unknown

/**
 * Abstraction over timer functions to enable testing with fake timers.
 */
export interface TimerFunctions {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/**
 * Configuration for the escalation timer.
 */
export interface EscalationTimerConfig {
  /** Whether warning-to-alarm escalation is enabled */
  enabled: boolean
  /** Timeout in seconds before escalation */
  timeoutSeconds: number
}

/**
 * Event emitted when an alert is escalated.
 */
export interface EscalationEvent {
  /** Alert ID that was escalated */
  alertId: string
  /** Priority before escalation */
  fromPriority: AlertPriority
  /** Priority after escalation */
  toPriority: AlertPriority
  /** ISO timestamp when escalation occurred */
  timestamp: string
}

/**
 * Callback invoked when escalation occurs.
 */
export type EscalationCallback = (event: EscalationEvent) => void

/**
 * Default timer functions using global setTimeout/clearTimeout.
 */
const defaultTimerFunctions: TimerFunctions = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/**
 * Escalation Timer
 *
 * Manages escalation timers for unacknowledged Warning alerts.
 * When a warning alert remains unacknowledged for the configured timeout,
 * it is escalated to Alarm priority.
 */
export class EscalationTimer {
  private config: EscalationTimerConfig
  private onEscalate: EscalationCallback
  private timerFns: TimerFunctions
  private activeTimers = new Map<string, TimerHandle>()
  private stopped = false

  constructor(
    config: EscalationTimerConfig,
    onEscalate: EscalationCallback,
    timerFunctions?: TimerFunctions
  ) {
    this.config = config
    this.onEscalate = onEscalate
    this.timerFns = timerFunctions ?? defaultTimerFunctions
  }

  /**
   * Start tracking an alert for potential escalation.
   * Only starts a timer for warning priority alerts.
   */
  startTimer(alertId: string, priority: AlertPriority): void {
    // Don't start timers if stopped
    if (this.stopped) {
      return
    }

    // Only escalate warnings
    if (priority !== 'warning') {
      return
    }

    // Don't start if escalation is disabled
    if (!this.config.enabled) {
      return
    }

    // Don't create duplicate timer
    if (this.activeTimers.has(alertId)) {
      return
    }

    // Create the timer
    const handle = this.timerFns.setTimeout(() => {
      this.handleEscalation(alertId)
    }, this.config.timeoutSeconds * 1000)

    this.activeTimers.set(alertId, handle)
  }

  /**
   * Cancel escalation timer for an alert.
   * Called when an alert is acknowledged or cleared.
   */
  cancelTimer(alertId: string): void {
    const handle = this.activeTimers.get(alertId)
    if (handle !== undefined) {
      this.timerFns.clearTimeout(handle)
      this.activeTimers.delete(alertId)
    }
  }

  /**
   * Check if an alert has an active escalation timer.
   */
  hasTimer(alertId: string): boolean {
    return this.activeTimers.has(alertId)
  }

  /**
   * Get the number of active escalation timers.
   */
  getActiveTimerCount(): number {
    return this.activeTimers.size
  }

  /**
   * Update configuration.
   * If escalation is disabled, cancels all active timers.
   */
  updateConfig(config: EscalationTimerConfig): void {
    const wasEnabled = this.config.enabled
    this.config = config

    // If escalation was disabled, cancel all active timers
    if (wasEnabled && !config.enabled) {
      this.cancelAllTimers()
    }
  }

  /**
   * Stop all timers and clean up.
   * Called when plugin is stopped.
   */
  stop(): void {
    this.stopped = true
    this.cancelAllTimers()
  }

  /**
   * Handle timer expiration - escalate the alert.
   */
  private handleEscalation(alertId: string): void {
    // Remove from active timers (timer has fired)
    this.activeTimers.delete(alertId)

    // Don't emit if stopped
    if (this.stopped) {
      return
    }

    // Emit escalation event
    const event: EscalationEvent = {
      alertId,
      fromPriority: 'warning',
      toPriority: 'alarm',
      timestamp: new Date().toISOString()
    }

    this.onEscalate(event)
  }

  /**
   * Cancel all active timers.
   */
  private cancelAllTimers(): void {
    for (const [alertId, handle] of this.activeTimers) {
      this.timerFns.clearTimeout(handle)
      this.activeTimers.delete(alertId)
    }
  }
}
