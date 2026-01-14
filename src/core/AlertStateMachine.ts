/**
 * Alert State Machine
 *
 * Implements the IEC 62682-based alert state machine for managing
 * alert lifecycle transitions.
 *
 * @see docs/SPEC.md Section 3 for state model specification
 * @see docs/plans/issue-7-alert-state-machine.md for implementation details
 */

import type { Alert, AlertPriority, AlertState } from '../types.js'

/**
 * Parameters for creating a new alert.
 */
export interface CreateAlertParams {
  /** ID of the source (plugin, client) that raised the alert */
  sourceId: string
  /** Alert priority level */
  priority: AlertPriority
  /** Human-readable alert message */
  message: string
  /** Optional grouping category */
  category?: string
  /** Whether alert latches (stays active after condition clears) */
  latching?: boolean
  /** Additional context data */
  data?: Record<string, unknown>
  /** Vessel context for multi-vessel deployments */
  context?: string
}

/**
 * Result of a state transition operation.
 */
export interface StateTransitionResult {
  /** The updated alert, or null if the alert was cleared */
  alert: Alert | null
  /** Whether the alert was cleared (removed from active alerts) */
  cleared: boolean
  /** The state before the transition */
  previousState: AlertState
}

/**
 * Generate a UUID v4 using the crypto API for proper uniqueness.
 */
function generateUUID(): string {
  return crypto.randomUUID()
}

/**
 * Create a new alert in the initial unacknowledged state.
 */
export function createAlert(params: CreateAlertParams): Alert {
  const now = new Date().toISOString()

  return {
    id: generateUUID(),
    sourceId: params.sourceId,
    priority: params.priority,
    state: 'unacknowledged',
    condition: true,
    latching: params.latching ?? false,
    silenced: false,
    message: params.message,
    category: params.category,
    data: params.data,
    raisedAt: now,
    sourceOnline: true,
    lastSourceUpdate: now,
    stale: false,
    context: params.context
  }
}

/**
 * Alert State Machine
 *
 * Manages alert state transitions following the IEC 62682 model.
 * All methods are pure functions that return new alert objects
 * without mutating the input.
 */
export class AlertStateMachine {
  /**
   * Check if a priority level requires acknowledgment before clearing.
   * Emergency, Alarm, and Warning require acknowledgment.
   * Caution auto-clears without requiring acknowledgment.
   */
  static requiresAcknowledgment(priority: AlertPriority): boolean {
    return priority !== 'caution'
  }

  /**
   * Check if an alert is in an unacknowledged state.
   * Both 'unacknowledged' and 'rtn-unacknowledged' count as unacknowledged.
   */
  static isUnacknowledged(alert: Alert): boolean {
    return alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
  }

  /**
   * Acknowledge an alert.
   *
   * Transitions:
   * - unacknowledged → acknowledged (if condition active)
   * - unacknowledged → cleared (if condition cleared and latching)
   * - rtn-unacknowledged → cleared
   * - acknowledged → acknowledged (idempotent)
   */
  acknowledge(alert: Alert, userId?: string): StateTransitionResult {
    const previousState = alert.state
    const now = new Date().toISOString()

    // RTN-unacknowledged: acknowledging clears the alert
    if (alert.state === 'rtn-unacknowledged') {
      return {
        alert: null,
        cleared: true,
        previousState
      }
    }

    // Latched alert with cleared condition: acknowledging clears it
    if (alert.state === 'unacknowledged' && alert.latching && !alert.condition) {
      return {
        alert: null,
        cleared: true,
        previousState
      }
    }

    // Already acknowledged: idempotent
    if (alert.state === 'acknowledged') {
      return {
        alert: { ...alert },
        cleared: false,
        previousState
      }
    }

    // Normal transition: unacknowledged → acknowledged
    return {
      alert: {
        ...alert,
        state: 'acknowledged',
        acknowledgedAt: now,
        acknowledgedBy: userId
      },
      cleared: false,
      previousState
    }
  }

  /**
   * Clear the alert condition.
   *
   * Transitions (for ack-required priorities: emergency, alarm, warning):
   * - unacknowledged → rtn-unacknowledged (unless latching)
   * - unacknowledged + latching → unacknowledged (stays, but condition=false)
   * - acknowledged → cleared
   * - rtn-unacknowledged → rtn-unacknowledged (idempotent)
   *
   * For caution priority:
   * - any state → cleared (auto-clears)
   */
  clearCondition(alert: Alert): StateTransitionResult {
    const previousState = alert.state
    const now = new Date().toISOString()

    // Already cleared condition: idempotent
    if (!alert.condition) {
      return {
        alert: { ...alert },
        cleared: false,
        previousState
      }
    }

    // Caution priority: auto-clears without requiring acknowledgment
    if (!AlertStateMachine.requiresAcknowledgment(alert.priority)) {
      return {
        alert: null,
        cleared: true,
        previousState
      }
    }

    // Acknowledged state: clearing condition removes the alert
    if (alert.state === 'acknowledged') {
      return {
        alert: null,
        cleared: true,
        previousState
      }
    }

    // Latched alert: stays in unacknowledged but condition becomes false
    if (alert.latching) {
      return {
        alert: {
          ...alert,
          condition: false,
          clearedAt: now
        },
        cleared: false,
        previousState
      }
    }

    // Normal transition: unacknowledged → rtn-unacknowledged
    return {
      alert: {
        ...alert,
        state: 'rtn-unacknowledged',
        condition: false,
        clearedAt: now
      },
      cleared: false,
      previousState
    }
  }

  /**
   * Set the alert condition state.
   *
   * Used when a condition reactivates after being cleared or deactivates.
   * - rtn-unacknowledged + condition=true → unacknowledged (reactivation)
   * - acknowledged + condition=true → acknowledged (stays)
   * - any state + condition=false → delegates to clearCondition
   *
   * Note: For setting condition to false, prefer using clearCondition() directly
   * as it provides proper state transitions. This method is primarily for
   * reactivating conditions.
   */
  setCondition(alert: Alert, active: boolean): StateTransitionResult {
    const previousState = alert.state

    // Deactivating condition: delegate to clearCondition for proper transitions
    if (!active) {
      return this.clearCondition(alert)
    }

    // Reactivating an RTN-unacknowledged alert
    if (alert.state === 'rtn-unacknowledged') {
      return {
        alert: {
          ...alert,
          state: 'unacknowledged',
          condition: true,
          clearedAt: undefined
        },
        cleared: false,
        previousState
      }
    }

    // For other states, just update the condition flag
    return {
      alert: {
        ...alert,
        condition: active
      },
      cleared: false,
      previousState
    }
  }

  /**
   * Silence an alert.
   *
   * Silencing suppresses audible indicators without acknowledging.
   * This does not affect the alert state.
   */
  silence(alert: Alert, until: Date): Alert {
    return {
      ...alert,
      silenced: true,
      silencedUntil: until.toISOString()
    }
  }

  /**
   * Remove silencing from an alert.
   */
  unsilence(alert: Alert): Alert {
    return {
      ...alert,
      silenced: false,
      silencedUntil: undefined
    }
  }
}
