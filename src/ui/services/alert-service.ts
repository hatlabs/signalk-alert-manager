/**
 * AlertService
 *
 * Fetches alerts from the REST API and subscribes to real-time updates
 * via the Signal K WebSocket delta stream.
 *
 * Dispatches 'change' events when the alert list is updated.
 */

import type { Alert, AlertFilter, AlertPriority, AlertState } from '../../types.js'
import { PRIORITY_ORDER } from '../styles/priority.js'

/**
 * Sort modes for the alert list.
 *
 * - 'standard': IMO MSC.302(87) §9.16 default — unacked first, then by
 *   priority, then oldest first within each group
 * - 'newest': Pure reverse-chronological (most recent first)
 */
export type SortBy = 'standard' | 'newest'

/** REST API base path for the alert manager plugin. */
const API_BASE = '/plugins/signalk-alert-manager'

export class AlertService extends EventTarget {
  private alerts = new Map<string, Alert>()
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private intentionalDisconnect = false

  private static readonly MAX_RECONNECT_DELAY = 30000

  /**
   * Connect to the REST API and WebSocket.
   * Fetches current alerts, then opens a WebSocket subscription for live updates.
   */
  async connect(): Promise<void> {
    await this.fetchAlerts()
    this.intentionalDisconnect = false
    this.connectWebSocket()
    this.dispatchEvent(new Event('change'))
  }

  /** Fetch the full alert list from the REST API. */
  private async fetchAlerts(): Promise<void> {
    const response = await fetch(`${API_BASE}/alerts`)
    if (!response.ok) {
      throw new Error(`Failed to fetch alerts: ${String(response.status)} ${response.statusText}`)
    }

    const alertList: Alert[] = await response.json()
    this.alerts.clear()
    for (const alert of alertList) {
      this.alerts.set(alert.id, alert)
    }
  }

  /** Close WebSocket and clear state. */
  disconnect(): void {
    this.intentionalDisconnect = true

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    this.alerts.clear()
  }

  /** Acknowledge an alert. State update arrives via WebSocket. */
  async acknowledgeAlert(id: string): Promise<void> {
    const response = await fetch(`${API_BASE}/alerts/${id}/acknowledge`, { method: 'POST' })
    if (!response.ok) {
      throw new Error(
        `Failed to acknowledge alert: ${String(response.status)} ${response.statusText}`
      )
    }
  }

  /** Silence an alert. Duration is in seconds; omit for server default. */
  async silenceAlert(id: string, duration?: number): Promise<void> {
    const body: Record<string, unknown> = {}
    if (duration !== undefined) {
      body.duration = duration
    }
    const response = await fetch(`${API_BASE}/alerts/${id}/silence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      throw new Error(`Failed to silence alert: ${String(response.status)} ${response.statusText}`)
    }
  }

  /** Silence all unacknowledged alerts. */
  async silenceAll(): Promise<void> {
    const response = await fetch(`${API_BASE}/alerts/silence-all`, { method: 'POST' })
    if (!response.ok) {
      throw new Error(
        `Failed to silence all alerts: ${String(response.status)} ${response.statusText}`
      )
    }
  }

  /**
   * Get alerts, optionally filtered and sorted.
   *
   * @param filter - Optional filter criteria (state, priority, category)
   * @param sortBy - Sort order: 'standard' (IMO default) or 'newest' (reverse chronological)
   */
  getAlerts(filter?: AlertFilter, sortBy: SortBy = 'standard'): Alert[] {
    let result = Array.from(this.alerts.values())

    if (filter) {
      result = applyFilter(result, filter)
    }

    return applySort(result, sortBy)
  }

  private connectWebSocket(): void {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/signalk/v1/stream?subscribe=none`

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.reconnectDelay = 1000

      // Re-sync from REST API before subscribing to deltas — this
      // prevents deltas from arriving while the fetch is in flight
      // and then being wiped by alerts.clear() when the fetch resolves.
      this.fetchAlerts()
        .then(() => {
          this.dispatchEvent(new Event('change'))
        })
        .catch(() => {
          // Non-fatal; we still have the previous state + live updates
        })
        .finally(() => {
          this.ws?.send(
            JSON.stringify({
              context: 'vessels.self',
              subscribe: [{ path: 'alerts.active.*', minPeriod: 0 }]
            })
          )
        })
    }

    this.ws.onmessage = (ev: MessageEvent) => {
      this.handleDelta(ev)
    }

    this.ws.onclose = () => {
      this.ws = null
      this.scheduleReconnect()
    }
  }

  private handleDelta(ev: MessageEvent): void {
    let delta: {
      updates?: Array<{
        values?: Array<{ path?: string; value?: unknown }>
      }>
    }

    try {
      delta = JSON.parse(String(ev.data))
    } catch {
      return
    }

    let changed = false

    for (const update of delta.updates ?? []) {
      for (const pathValue of update.values ?? []) {
        if (!pathValue.path?.startsWith('alerts.active.')) {
          continue
        }

        const alertId = pathValue.path.slice('alerts.active.'.length)

        if (pathValue.value === null || pathValue.value === undefined) {
          if (this.alerts.delete(alertId)) {
            changed = true
          }
        } else {
          this.alerts.set(alertId, pathValue.value as Alert)
          changed = true
        }
      }
    }

    if (changed) {
      this.dispatchEvent(new Event('change'))
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectWebSocket()
    }, this.reconnectDelay)

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, AlertService.MAX_RECONNECT_DELAY)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function applyFilter(alerts: Alert[], filter: AlertFilter): Alert[] {
  let result = alerts

  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state]
    result = result.filter((a) => states.includes(a.state))
  }

  if (filter.priority !== undefined) {
    const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
    result = result.filter((a) => priorities.includes(a.priority))
  }

  if (filter.category !== undefined) {
    const needle = filter.category.toLowerCase()
    result = result.filter((a) => a.category?.toLowerCase().includes(needle))
  }

  if (filter.stale !== undefined) {
    result = result.filter((a) => a.stale === filter.stale)
  }

  return result
}

/**
 * Unacknowledged states need operator attention and sort before acknowledged.
 * Lower number = higher display priority.
 */
const STATE_ORDER: Record<AlertState, number> = {
  unacknowledged: 0,
  'rtn-unacknowledged': 0,
  acknowledged: 1
}

function applySort(alerts: Alert[], sortBy: SortBy): Alert[] {
  return alerts.slice().sort((a, b) => {
    if (sortBy === 'newest') {
      return newestFirst(a.raisedAt, b.raisedAt)
    }
    // IMO MSC.302(87) §9.16 default: state → priority → oldest first
    const sDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state]
    if (sDiff !== 0) return sDiff
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (pDiff !== 0) return pDiff
    return oldestFirst(a.raisedAt, b.raisedAt)
  })
}

function oldestFirst(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime()
}

function newestFirst(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime()
}

// ---------------------------------------------------------------------------
// Shared singleton with reference counting
// ---------------------------------------------------------------------------

let sharedInstance: AlertService | null = null
let refCount = 0

/**
 * Acquire the shared AlertService singleton.
 * First caller triggers connect(); subsequent callers reuse the connection.
 */
export function acquireAlertService(): AlertService {
  if (!sharedInstance) {
    sharedInstance = new AlertService()
    sharedInstance.connect().catch(() => {
      // Connection failure; the service will retry via WebSocket reconnect
    })
  }
  refCount++
  return sharedInstance
}

/**
 * Release the shared AlertService singleton.
 * When the last consumer releases, the connection is closed.
 */
export function releaseAlertService(): void {
  if (refCount <= 0) return
  if (--refCount <= 0) {
    sharedInstance?.disconnect()
    sharedInstance = null
    refCount = 0
  }
}

/** @internal Reset shared state. For testing only. */
export function _resetAlertServiceSingleton(): void {
  sharedInstance?.disconnect()
  sharedInstance = null
  refCount = 0
}
