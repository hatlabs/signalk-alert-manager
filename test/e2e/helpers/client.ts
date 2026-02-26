/**
 * E2E Test HTTP Client
 *
 * Typed wrapper around fetch for the alert-manager REST API endpoints.
 */

import type { Alert, AlertFilter, HistoryQuery, IndicationState } from '../../../src/types.js'

const BASE_PATH = '/plugins/signalk-alert-manager'

export interface AlertTransitionResponse {
  alert: Alert | null
  cleared: boolean
  previousState: string
}

export interface HistoryResponse {
  entries: {
    id: string
    alertId: string
    eventType: string
    timestamp: string
    userId?: string
    previousState?: string
    newState?: string
    previousPriority?: string
    newPriority?: string
    details?: Record<string, unknown>
  }[]
  total: number
}

export class AlertClient {
  private host: string

  constructor(host: string) {
    this.host = host
  }

  private url(path: string): string {
    return `${this.host}${BASE_PATH}${path}`
  }

  /** GET /alerts — list all alerts, optionally filtered */
  async getAlerts(filter?: AlertFilter): Promise<Response> {
    const params = new URLSearchParams()
    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state]
      params.set('state', states.join(','))
    }
    if (filter?.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
      params.set('priority', priorities.join(','))
    }
    if (filter?.category) {
      params.set('category', filter.category)
    }
    if (filter?.stale !== undefined) {
      params.set('stale', String(filter.stale))
    }
    const qs = params.toString()
    return fetch(this.url(`/alerts${qs ? `?${qs}` : ''}`))
  }

  /** POST /alerts — raise a new alert */
  async raiseAlert(body: {
    path: string
    priority: string
    message: string
    category?: string
    data?: Record<string, unknown>
    latching?: boolean
    $source?: string
  }): Promise<Response> {
    return fetch(this.url('/alerts'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /** GET /alerts/indication — get current indication state */
  async getIndication(): Promise<Response> {
    return fetch(this.url('/alerts/indication'))
  }

  /** GET /alerts/history — get alert history */
  async getHistory(query?: HistoryQuery): Promise<Response> {
    const params = new URLSearchParams()
    if (query?.from) params.set('from', query.from)
    if (query?.to) params.set('to', query.to)
    if (query?.alertId) params.set('alertId', query.alertId)
    if (query?.eventType) {
      const types = Array.isArray(query.eventType) ? query.eventType : [query.eventType]
      params.set('eventType', types.join(','))
    }
    if (query?.limit !== undefined) params.set('limit', String(query.limit))
    if (query?.offset !== undefined) params.set('offset', String(query.offset))
    const qs = params.toString()
    return fetch(this.url(`/alerts/history${qs ? `?${qs}` : ''}`))
  }

  /** POST /alerts/silence-all — silence all unacknowledged alerts */
  async silenceAll(): Promise<Response> {
    return fetch(this.url('/alerts/silence-all'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /** GET /alerts/:id — get a specific alert */
  async getAlert(id: string): Promise<Response> {
    return fetch(this.url(`/alerts/${id}`))
  }

  /** POST /alerts/:id/acknowledge — acknowledge an alert */
  async acknowledgeAlert(id: string): Promise<Response> {
    return fetch(this.url(`/alerts/${id}/acknowledge`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /** POST /alerts/:id/silence — silence an alert */
  async silenceAlert(id: string, body?: { duration?: number }): Promise<Response> {
    return fetch(this.url(`/alerts/${id}/silence`), {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /** PUT /alerts/:id/condition — update alert condition */
  async updateCondition(id: string, body: { active: boolean }): Promise<Response> {
    return fetch(this.url(`/alerts/${id}/condition`), {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // ---- Convenience methods returning typed data ----

  async getAlertsJson(filter?: AlertFilter): Promise<Alert[]> {
    const res = await this.getAlerts(filter)
    return (await res.json()) as Alert[]
  }

  async raiseAlertJson(body: {
    path: string
    priority: string
    message: string
    category?: string
    data?: Record<string, unknown>
    latching?: boolean
    $source?: string
  }): Promise<Alert> {
    const res = await this.raiseAlert(body)
    return (await res.json()) as Alert
  }

  async getIndicationJson(): Promise<IndicationState> {
    const res = await this.getIndication()
    return (await res.json()) as IndicationState
  }

  async getHistoryJson(query?: HistoryQuery): Promise<HistoryResponse> {
    const res = await this.getHistory(query)
    return (await res.json()) as HistoryResponse
  }

  async getAlertJson(id: string): Promise<Alert> {
    const res = await this.getAlert(id)
    return (await res.json()) as Alert
  }

  async acknowledgeAlertJson(id: string): Promise<AlertTransitionResponse> {
    const res = await this.acknowledgeAlert(id)
    return (await res.json()) as AlertTransitionResponse
  }

  async updateConditionJson(
    id: string,
    body: { active: boolean }
  ): Promise<AlertTransitionResponse> {
    const res = await this.updateCondition(id, body)
    return (await res.json()) as AlertTransitionResponse
  }
}
