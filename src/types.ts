/**
 * signalk-alert-manager Type Definitions
 *
 * Type definitions for the alert management system based on:
 * - IMO MSC.302(87) Bridge Alert Management Performance Standards
 * - IEC 62682:2023 Management of alarm systems for the process industries
 *
 * @see docs/SPEC.md Section 4 for detailed specifications
 * @see docs/ARCHITECTURE.md Section 3 for data model design
 */

// =============================================================================
// Core Types
// =============================================================================

/**
 * Alert priority levels following the IMO model.
 *
 * - emergency: Immediate danger to life or vessel; immediate action required
 * - alarm: Conditions requiring immediate attention to maintain safe operation
 * - warning: Conditions requiring attention for precautionary reasons
 * - caution: Conditions requiring attention but not immediately hazardous
 */
export type AlertPriority = 'emergency' | 'alarm' | 'warning' | 'caution'

/**
 * Alert states based on IEC 62682 simplified model.
 *
 * - unacknowledged: Alert active, operator has not acknowledged (State B)
 * - acknowledged: Alert active, operator has acknowledged (State C)
 * - rtn-unacknowledged: Condition cleared before acknowledgment, awaiting ack (State D)
 */
export type AlertState = 'unacknowledged' | 'acknowledged' | 'rtn-unacknowledged'

/**
 * Full alert instance representing an active or historical alert.
 *
 * Alerts are the core data structure tracking abnormal conditions that require
 * operator attention. Each alert has a unique ID and tracks its full lifecycle.
 */
export interface Alert {
  /** Unique alert instance ID (UUID) */
  id: string

  /** ID of the source (plugin, client) that raised the alert */
  sourceId: string

  /** Alert priority level */
  priority: AlertPriority

  /** Current alert state in the IEC 62682 model */
  state: AlertState

  /** Whether the triggering condition is currently active */
  condition: boolean

  /** Whether alert latches (stays active after condition clears) */
  latching: boolean

  /** Whether audible indicators are silenced */
  silenced: boolean

  /** ISO timestamp when silence expires */
  silencedUntil?: string

  /** Human-readable alert message */
  message: string

  /** Optional grouping category (e.g., "engine", "navigation") */
  category?: string

  /** Additional context data */
  data?: Record<string, unknown>

  /** ISO timestamp when alert was first raised */
  raisedAt: string

  /** ISO timestamp when operator acknowledged */
  acknowledgedAt?: string

  /** User/client identifier that acknowledged */
  acknowledgedBy?: string

  /** ISO timestamp when condition cleared */
  clearedAt?: string

  /** Whether the source is currently reachable */
  sourceOnline: boolean

  /** ISO timestamp of last update from source */
  lastSourceUpdate: string

  /** Whether source went offline while alert was active */
  stale: boolean

  /** Vessel context for multi-vessel deployments */
  context?: string
}

/**
 * Alert definition for registered alert types.
 *
 * Plugins can register alert types with predefined behavior, allowing
 * consistent handling of common alert scenarios.
 */
export interface AlertDefinition {
  /** Unique type identifier (e.g., "engine.coolant.high") */
  alertType: string

  /** Default priority when raising this alert type */
  defaultPriority: AlertPriority

  /** Whether alerts of this type latch */
  latching: boolean

  /** Optional automatic escalation configuration */
  escalation?: {
    /** Priority to escalate to */
    toPriority: AlertPriority
    /** Seconds before escalation if unacknowledged */
    afterSeconds: number
  }

  /** Message template or static message */
  message: string

  /** Optional default category */
  category?: string
}

/**
 * Current indication state for hardware integration.
 *
 * Represents the aggregate state for driving physical alarm panels,
 * buzzers, and displays.
 */
export interface IndicationState {
  /** Whether audible indicators should be active */
  audible: boolean

  /** Highest priority of unacknowledged alerts, or null if none */
  priority: AlertPriority | null

  /** Whether visual indicators should flash */
  flash: boolean

  /** Whether audible indicators are currently silenced */
  silenced: boolean

  /** Count of unacknowledged alerts */
  unacknowledgedCount: number
}

// =============================================================================
// API Types
// =============================================================================

/**
 * Request body for raising a new alert via REST API or plugin API.
 */
export interface RaiseAlertRequest {
  /** Alert priority level */
  priority: AlertPriority

  /** Human-readable alert message */
  message: string

  /** Optional category for grouping */
  category?: string

  /** Optional additional context data */
  data?: Record<string, unknown>

  /** Whether the alert should latch (default: false) */
  latching?: boolean
}

/**
 * Filter criteria for querying alerts.
 */
export interface AlertFilter {
  /** Filter by alert state(s) */
  state?: AlertState | AlertState[]

  /** Filter by priority level(s) */
  priority?: AlertPriority | AlertPriority[]

  /** Filter by category */
  category?: string

  /** Filter by stale status */
  stale?: boolean
}

/**
 * Query parameters for retrieving alert history.
 */
export interface HistoryQuery {
  /** Start of date range (UTC ISO 8601 timestamp ending in Z) */
  from?: string

  /** End of date range (UTC ISO 8601 timestamp ending in Z) */
  to?: string

  /** Filter by specific alert ID */
  alertId?: string

  /** Filter by event type(s) */
  eventType?: HistoryEventType | HistoryEventType[]

  /** Maximum number of entries to return */
  limit?: number

  /** Number of entries to skip (for pagination, requires limit) */
  offset?: number
}

/**
 * Types of events recorded in alert history.
 */
export type HistoryEventType =
  | 'raise'
  | 'acknowledge'
  | 'silence'
  | 'unsilence'
  | 'clear'
  | 'escalate'

/**
 * A single entry in the alert history log.
 *
 * History entries provide a complete audit trail of all alert lifecycle
 * events for compliance and debugging purposes.
 */
export interface HistoryEntry {
  /** Unique history entry ID */
  id: string

  /** ID of the alert this entry relates to */
  alertId: string

  /** Type of event that occurred */
  eventType: HistoryEventType

  /** ISO timestamp when the event occurred */
  timestamp: string

  /** User/client that triggered the event (if applicable) */
  userId?: string

  /** Alert state before the event */
  previousState?: AlertState

  /** Alert state after the event */
  newState?: AlertState

  /** Priority before escalation (for escalate events) */
  previousPriority?: AlertPriority

  /** Priority after escalation (for escalate events) */
  newPriority?: AlertPriority

  /** Additional event-specific details */
  details?: Record<string, unknown>
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Plugin configuration structure.
 *
 * All fields are optional - defaults are applied by the plugin.
 * @see docs/SPEC.md Section 10 for configuration details
 */
export interface PluginConfig {
  /** Escalation settings for priority promotion */
  escalation?: {
    warningToAlarm?: {
      /** Enable automatic warning-to-alarm escalation */
      enabled?: boolean
      /** Seconds before unacknowledged warning escalates to alarm */
      timeoutSeconds?: number
    }
  }

  /** Silencing duration limits */
  silencing?: {
    /** Maximum seconds a non-emergency alert can be silenced (default: 120) */
    defaultMaxSilenceSeconds?: number
    /** Maximum seconds an emergency can be silenced (default: 30) */
    emergencyMaxSilenceSeconds?: number
  }

  /** Source timeout settings */
  sourceTimeout?: {
    /** Seconds before marking alert as stale if source stops updating */
    markStaleAfterSeconds?: number
  }

  /** Alert history retention settings */
  history?: {
    /** Days to retain alert history (default: 90) */
    retentionDays?: number
  }

  /** Audio settings for the browser UI */
  audio?: {
    /** Minimum priority that triggers audible alerts: 'off', 'emergency', 'alarm', or 'warning' (default: 'warning') */
    minAudiblePriority?: 'off' | 'emergency' | 'alarm' | 'warning'
  }
}

// =============================================================================
// Plugin API Types
// =============================================================================

/**
 * Result of a state transition, as returned by the plugin API.
 */
export interface AlertTransitionResult {
  /** The updated alert, or null if the alert was cleared */
  alert: Alert | null
  /** Whether the alert was cleared (removed from active alerts) */
  cleared: boolean
  /** The state before the transition */
  previousState: AlertState
}

/**
 * Public API exposed on app.alertManager for other Signal K plugins.
 */
export interface AlertManagerAPI {
  raiseAlert(params: RaiseAlertRequest & { sourceId: string }): Promise<Alert>
  clearCondition(alertId: string): Promise<AlertTransitionResult>
  acknowledgeAlert(alertId: string, userId?: string): Promise<AlertTransitionResult>
  silenceAlert(alertId: string, durationMs?: number): Promise<Alert>
  silenceAll(): Promise<void>
  getAlerts(filter?: AlertFilter): Alert[]
  getAlert(id: string): Alert | null
  getIndicationState(): IndicationState
  registerAlertType(definition: AlertDefinition): void
}

// =============================================================================
// Module Augmentation
// =============================================================================

declare module '@signalk/server-api' {
  interface ServerAPI {
    alertManager?: AlertManagerAPI
  }
}

// =============================================================================
// Interface Types
// =============================================================================

/**
 * Persistence abstraction interface for alert history.
 *
 * Implementations provide an append-only audit log of alert lifecycle
 * events for compliance and debugging purposes.
 */
export interface IHistoryStore {
  initialize(): Promise<void>
  close(): Promise<void>
  log(entry: Omit<HistoryEntry, 'id'>): Promise<void>
  query(query: HistoryQuery): Promise<{ entries: HistoryEntry[]; total: number }>
  prune(olderThanDays: number): Promise<number>
}

/**
 * Persistence abstraction interface for alert storage.
 *
 * Implementations of this interface provide persistent storage for alerts,
 * allowing alert state to survive plugin restarts. The AlertManager can
 * operate without a store (in-memory only) or with a store for persistence.
 */
export interface IAlertStore {
  /**
   * Initialize the store (create tables, open connections, etc.)
   */
  initialize(): Promise<void>

  /**
   * Close the store and release resources.
   */
  close(): Promise<void>

  /**
   * Save a new alert to the store.
   */
  save(alert: Alert): Promise<void>

  /**
   * Retrieve an alert by ID.
   * @returns The alert if found, null otherwise
   */
  get(id: string): Promise<Alert | null>

  /**
   * Retrieve all alerts matching the optional filter.
   */
  getAll(filter?: AlertFilter): Promise<Alert[]>

  /**
   * Update an existing alert in the store.
   */
  update(alert: Alert): Promise<void>

  /**
   * Delete an alert from the store.
   */
  delete(id: string): Promise<void>
}
