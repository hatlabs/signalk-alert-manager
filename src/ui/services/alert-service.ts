/**
 * AlertService
 *
 * Fetches alerts from the REST API and subscribes to real-time updates
 * via the Signal K WebSocket delta stream.
 *
 * Dispatches 'change' events when the alert list is updated.
 */

import type { Alert, AlertFilter, AlertPriority } from '../../types.js'
import { PRIORITY_ORDER } from '../styles/priority.js'

export type SortBy = 'time' | 'priority'

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

  /**
   * Get alerts, optionally filtered and sorted.
   *
   * @param filter - Optional filter criteria (state, priority, category)
   * @param sortBy - Sort order: 'time' (newest first, default) or 'priority' (highest first)
   */
  getAlerts(filter?: AlertFilter, sortBy: SortBy = 'time'): Alert[] {
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

      // Re-sync alert state from REST API to catch changes missed during disconnect
      this.fetchAlerts()
        .then(() => {
          this.dispatchEvent(new Event('change'))
        })
        .catch(() => {
          // Non-fatal; we still have the previous state + live updates
        })

      this.ws?.send(
        JSON.stringify({
          context: 'vessels.self',
          subscribe: [{ path: 'alerts.active.*', minPeriod: 0 }]
        })
      )
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
    result = result.filter((a) => a.category === filter.category)
  }

  if (filter.stale !== undefined) {
    result = result.filter((a) => a.stale === filter.stale)
  }

  return result
}

function applySort(alerts: Alert[], sortBy: SortBy): Alert[] {
  return alerts.slice().sort((a, b) => {
    if (sortBy === 'priority') {
      const pDiff = priorityCompare(a.priority, b.priority)
      if (pDiff !== 0) return pDiff
      // Same priority: newest first
      return timeCompare(a.raisedAt, b.raisedAt)
    }
    // Default: newest first
    return timeCompare(a.raisedAt, b.raisedAt)
  })
}

function priorityCompare(a: AlertPriority, b: AlertPriority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b]
}

function timeCompare(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime()
}
