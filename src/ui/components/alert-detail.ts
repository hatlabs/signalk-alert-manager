/**
 * AlertDetail - Expanded view for a single alert.
 *
 * Shows full alert information, history timeline, and action buttons.
 * Uses AlertService for live alert updates and fetches history from REST API.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert, HistoryEntry, HistoryEventType } from '../../types.js'
import { AlertService } from '../services/alert-service.js'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATE_LABELS } from '../styles/priority.js'
import { formatTime } from '../utils/format.js'

const API_BASE = '/plugins/signalk-alert-manager'

/** Timeout before re-enabling buttons if no WebSocket update arrives. */
const ACTION_TIMEOUT_MS = 5000

const EVENT_TYPE_LABELS: Record<HistoryEventType, string> = {
  raise: 'Raised',
  acknowledge: 'Acknowledged',
  silence: 'Silenced',
  unsilence: 'Unsilenced',
  clear: 'Cleared',
  escalate: 'Escalated'
}

export class AlertDetail extends LitElement {
  static properties = {
    alertId: { type: String, attribute: 'alert-id' },
    alert: { state: true },
    history: { state: true },
    historyError: { state: true },
    error: { state: true },
    actionInFlight: { state: true }
  }

  static styles = css`
    :host {
      display: block;
    }

    .detail-card {
      border: 2px solid var(--priority-color, #666);
      border-radius: 6px;
      background: var(--priority-bg, #fff);
      overflow: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      border-bottom: 1px solid #e0e0e0;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .priority {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--priority-color, #666);
    }

    .state {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      background: #e0e0e0;
      color: #333;
    }

    .category {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      background: #f0f0f0;
      color: #666;
    }

    .stale {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      background: #fff3cd;
      color: #856404;
    }

    .silenced {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      background: #e8eaf6;
      color: #3949ab;
    }

    button[data-action='close'] {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #fff;
      font-size: 0.8rem;
      cursor: pointer;
      touch-action: manipulation;
    }

    .body {
      padding: 0.75rem;
    }

    .message {
      font-size: 1rem;
      color: #222;
      margin-bottom: 0.75rem;
    }

    .info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.25rem 0.75rem;
      font-size: 0.85rem;
      margin-bottom: 1rem;
    }

    .info-label {
      color: #666;
      font-weight: 600;
    }

    .info-value {
      color: #333;
    }

    .source {
      color: #333;
    }

    .data {
      margin-bottom: 1rem;
    }

    .data-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: #666;
      margin-bottom: 0.25rem;
    }

    .data pre {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      overflow-x: auto;
      max-height: 200px;
      overflow-y: auto;
      margin: 0;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .actions button {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #fff;
      cursor: pointer;
      touch-action: manipulation;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .actions button svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    .actions button:hover:not(:disabled) {
      background: #f5f5f5;
    }

    .actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .actions button[data-action='acknowledge'] {
      border-color: #4caf50;
      color: #2e7d32;
    }

    .actions button[data-action='silence'] {
      border-color: #1976d2;
      color: #1565c0;
    }

    .timeline-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #444;
      margin-bottom: 0.5rem;
    }

    .timeline {
      border-left: 2px solid #e0e0e0;
      padding-left: 1rem;
    }

    .timeline-entry {
      position: relative;
      margin-bottom: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #f0f0f0;
    }

    .timeline-entry:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }

    .timeline-entry::before {
      content: '';
      position: absolute;
      left: -1.35rem;
      top: 0.35rem;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #999;
    }

    .event-type {
      font-size: 0.8rem;
      font-weight: 600;
      color: #444;
    }

    .event-time {
      font-size: 0.75rem;
      color: #888;
      margin-left: 0.5rem;
    }

    .event-details {
      font-size: 0.8rem;
      color: #666;
      margin-top: 0.125rem;
    }

    .timeline-empty {
      font-size: 0.85rem;
      color: #888;
      font-style: italic;
    }

    .timeline-error {
      font-size: 0.85rem;
      color: #d32f2f;
      font-style: italic;
    }

    .error {
      padding: 1rem;
      color: #d32f2f;
      text-align: center;
    }

    .loading {
      padding: 1rem;
      color: #888;
      text-align: center;
    }
  `

  declare alertId: string
  declare alert: Alert | null
  declare history: HistoryEntry[]
  declare historyError: boolean
  declare error: string | null
  declare actionInFlight: boolean

  private service = new AlertService()
  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.alertId = ''
    this.alert = null
    this.history = []
    this.historyError = false
    this.error = null
    this.actionInFlight = false
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service.addEventListener('change', this.onServiceChange)
    this.service.connect().catch(() => {
      // Connection failure; will retry
    })
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.service.disconnect()
    this.clearSafetyTimer()
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('alertId') && this.alertId) {
      this.loadHistory()
    }
    // Reset actionInFlight when alert data changes (action completed)
    if (changed.has('alert') && this.alert) {
      this.actionInFlight = false
      this.clearSafetyTimer()
    }
  }

  private onServiceChange = (): void => {
    if (!this.alertId) return
    const alerts = this.service.getAlerts()
    const match = alerts.find((a) => a.id === this.alertId)
    if (match) {
      this.alert = match
      this.error = null
    } else if (this.alert) {
      // Alert was cleared — keep showing last state but update the view
      this.alert = null
      this.error = 'Alert has been cleared'
    }
  }

  private async loadHistory(): Promise<void> {
    this.historyError = false
    try {
      const response = await fetch(
        `${API_BASE}/alerts/history?alertId=${encodeURIComponent(this.alertId)}`
      )
      if (!response.ok) {
        this.historyError = true
        return
      }
      const result: { entries: HistoryEntry[]; total: number } = await response.json()
      this.history = result.entries
    } catch {
      this.historyError = true
    }
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  private onClose(): void {
    this.dispatchEvent(new CustomEvent('alert-detail-close', { bubbles: true, composed: true }))
  }

  private onAcknowledge(): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    this.service.acknowledgeAlert(this.alertId).catch(() => {
      this.actionInFlight = false
    })
  }

  private onSilence(): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    this.service.silenceAlert(this.alertId).catch(() => {
      this.actionInFlight = false
    })
  }

  render() {
    if (this.error) {
      return html`<div class="error">${this.error}</div>`
    }

    if (!this.alert) {
      return html`<div class="loading">Loading...</div>`
    }

    const colors = PRIORITY_COLORS[this.alert.priority]
    const isUnacked =
      this.alert.state === 'unacknowledged' || this.alert.state === 'rtn-unacknowledged'
    const showAck = isUnacked
    const showSilence = isUnacked && !this.alert.silenced

    return html`
      <div
        class="detail-card"
        style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
      >
        <div class="header">
          <div class="header-left">
            <span class="priority">${PRIORITY_LABELS[this.alert.priority]}</span>
            <span class="state">${STATE_LABELS[this.alert.state]}</span>
            ${this.alert.category
              ? html`<span class="category">${this.alert.category}</span>`
              : nothing}
            ${this.alert.stale ? html`<span class="stale">Stale</span>` : nothing}
            ${this.alert.silenced ? html`<span class="silenced">Silenced</span>` : nothing}
          </div>
          <button data-action="close" aria-label="Close detail view" @click=${this.onClose}>
            Close
          </button>
        </div>

        <div class="body">
          <div class="message">${this.alert.message}</div>

          <div class="info-grid">
            <span class="info-label">Source</span>
            <span class="info-value source">${this.alert.sourceId}</span>
            <span class="info-label">Raised</span>
            <span class="info-value">${formatTime(this.alert.raisedAt)}</span>
            ${this.alert.acknowledgedAt
              ? html`
                  <span class="info-label">Acknowledged</span>
                  <span class="info-value">${formatTime(this.alert.acknowledgedAt)}</span>
                `
              : nothing}
            ${this.alert.acknowledgedBy
              ? html`
                  <span class="info-label">Acknowledged by</span>
                  <span class="info-value">${this.alert.acknowledgedBy}</span>
                `
              : nothing}
            ${this.alert.clearedAt
              ? html`
                  <span class="info-label">Cleared</span>
                  <span class="info-value">${formatTime(this.alert.clearedAt)}</span>
                `
              : nothing}
            <span class="info-label">Source online</span>
            <span class="info-value">${this.alert.sourceOnline ? 'Yes' : 'No'}</span>
            <span class="info-label">Last update</span>
            <span class="info-value">${formatTime(this.alert.lastSourceUpdate)}</span>
          </div>

          ${this.alert.data && Object.keys(this.alert.data).length > 0
            ? html`
                <div class="data">
                  <div class="data-title">Data</div>
                  <pre>${JSON.stringify(this.alert.data, null, 2)}</pre>
                </div>
              `
            : nothing}
          ${showAck || showSilence
            ? html`
                <div class="actions">
                  ${showAck
                    ? html`<button
                        data-action="acknowledge"
                        aria-label="Acknowledge: ${this.alert.message}"
                        ?disabled=${this.actionInFlight}
                        @click=${this.onAcknowledge}
                      >
                        <svg viewBox="0 0 24 24">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        </svg>
                      </button>`
                    : nothing}
                  ${showSilence
                    ? html`<button
                        data-action="silence"
                        aria-label="Silence: ${this.alert.message}"
                        ?disabled=${this.actionInFlight}
                        @click=${this.onSilence}
                      >
                        <svg viewBox="0 0 24 24">
                          <path
                            d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                          />
                        </svg>
                      </button>`
                    : nothing}
                </div>
              `
            : nothing}

          <div class="timeline-title">History</div>
          ${this.historyError
            ? html`<div class="timeline-error">Failed to load history</div>`
            : this.history.length === 0
              ? html`<div class="timeline-empty">No history available</div>`
              : html`
                  <div class="timeline" role="list">
                    ${this.history.map(
                      (entry) => html`
                        <div class="timeline-entry" role="listitem">
                          <span class="event-type">${EVENT_TYPE_LABELS[entry.eventType]}</span>
                          <span class="event-time">${formatTime(entry.timestamp)}</span>
                          ${this.renderEventDetails(entry)}
                        </div>
                      `
                    )}
                  </div>
                `}
        </div>
      </div>
    `
  }

  private renderEventDetails(entry: HistoryEntry) {
    const parts: string[] = []

    if (entry.userId) {
      parts.push(`by ${entry.userId}`)
    }

    if (entry.eventType === 'escalate' && entry.previousPriority && entry.newPriority) {
      parts.push(
        `${PRIORITY_LABELS[entry.previousPriority]} → ${PRIORITY_LABELS[entry.newPriority]}`
      )
    }

    if (entry.previousState && entry.newState) {
      parts.push(`${STATE_LABELS[entry.previousState]} → ${STATE_LABELS[entry.newState]}`)
    }

    if (parts.length === 0) {
      return nothing
    }

    return html`<div class="event-details">${parts.join(' — ')}</div>`
  }
}

customElements.define('alert-detail', AlertDetail)
