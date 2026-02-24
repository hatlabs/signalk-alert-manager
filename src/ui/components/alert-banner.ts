/**
 * AlertBanner - Persistent banner showing the highest-priority unacknowledged alert.
 *
 * Provides immediate visibility of the most critical active alert without
 * requiring operators to scroll through the full alert list.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../../types.js'
import { AlertService } from '../services/alert-service.js'
import { ICON_ACKNOWLEDGE } from '../styles/icons.js'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATE_LABELS } from '../styles/priority.js'
import { formatTime } from '../utils/format.js'

/** Timeout before re-enabling button if no WebSocket update arrives. */
const ACTION_TIMEOUT_MS = 5000

export class AlertBanner extends LitElement {
  static properties = {
    topAlert: { state: true },
    expanded: { state: true },
    actionInFlight: { state: true }
  }

  static styles = css`
    :host {
      display: block;
    }

    .banner {
      display: flex;
      align-items: stretch;
      border: 2px solid var(--priority-color, #666);
      border-radius: 6px;
      background: var(--priority-bg, #fff);
      margin-bottom: 1rem;
      overflow: hidden;
    }

    .banner.flashing {
      animation: flash 1s ease-in-out infinite;
    }

    @keyframes flash {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.6;
      }
    }

    .priority-bar {
      width: 6px;
      flex-shrink: 0;
      background: var(--priority-color, #666);
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .main-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
    }

    .priority {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--priority-color, #666);
      flex-shrink: 0;
    }

    .message {
      font-size: 0.9rem;
      color: #222;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toggle-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.8rem;
      color: #666;
      padding: 0.25rem;
      flex-shrink: 0;
      min-height: 44px;
      min-width: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      touch-action: manipulation;
    }

    .toggle-btn:hover {
      color: #333;
    }

    .actions {
      display: flex;
      align-items: center;
      padding: 0 0.75rem;
    }

    .actions button {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem;
      border: 1px solid #4caf50;
      border-radius: 4px;
      background: #fff;
      color: #2e7d32;
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

    .details {
      display: flex;
      gap: 0.5rem;
      padding: 0 0.75rem 0.5rem;
      flex-wrap: wrap;
      align-items: center;
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

    .time {
      font-size: 0.75rem;
      color: #888;
    }
  `

  declare topAlert: Alert | null
  declare expanded: boolean
  declare actionInFlight: boolean

  private service = new AlertService()
  private previousAlertId: string | null = null
  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.topAlert = null
    this.expanded = false
    this.actionInFlight = false
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service.addEventListener('change', this.onServiceChange)
    this.service.connect().catch(() => {
      // Connection failure; banner stays empty until retry succeeds
    })
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.service.disconnect()
    this.clearSafetyTimer()
  }

  private onServiceChange = (): void => {
    this.updateTopAlert()
  }

  private updateTopAlert(): void {
    const unacked = this.service.getAlerts(
      { state: ['unacknowledged', 'rtn-unacknowledged'] },
      'standard'
    )
    const newTop = unacked[0] ?? null

    if (newTop?.id !== this.previousAlertId) {
      this.expanded = false
      this.actionInFlight = false
      this.clearSafetyTimer()
      this.previousAlertId = newTop?.id ?? null
    }

    this.topAlert = newTop
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  private onAcknowledge(): void {
    if (!this.topAlert) return
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    this.service.acknowledgeAlert(this.topAlert.id).catch(() => {
      // State will remain unchanged via WebSocket
    })
  }

  private onToggle(): void {
    this.expanded = !this.expanded
  }

  render() {
    if (!this.topAlert) {
      return nothing
    }

    const alert = this.topAlert
    const colors = PRIORITY_COLORS[alert.priority]
    const isUnacked = alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
    const showAck = isUnacked

    return html`
      <div
        class="banner ${isUnacked ? 'flashing' : ''}"
        role="alert"
        style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
      >
        <div class="priority-bar"></div>
        <div class="body">
          <div class="main-row">
            <span class="priority">${PRIORITY_LABELS[alert.priority]}</span>
            <span class="message">${alert.message}</span>
            <button
              class="toggle-btn"
              data-action="toggle"
              aria-label="${this.expanded ? 'Collapse details' : 'Expand details'}"
              @click=${this.onToggle}
            >
              ${this.expanded ? '\u25B2' : '\u25BC'}
            </button>
          </div>
          ${this.expanded
            ? html`
                <div class="details">
                  <span class="state">${STATE_LABELS[alert.state]}</span>
                  ${alert.category
                    ? html`<span class="category">${alert.category}</span>`
                    : nothing}
                  ${alert.stale ? html`<span class="stale">Stale</span>` : nothing}
                  <span class="time">${formatTime(alert.raisedAt)}</span>
                </div>
              `
            : nothing}
        </div>
        ${showAck
          ? html`
              <div class="actions">
                <button
                  data-action="acknowledge"
                  title="Acknowledge"
                  aria-label="Acknowledge: ${alert.message}"
                  ?disabled=${this.actionInFlight}
                  @click=${this.onAcknowledge}
                >
                  <svg viewBox="0 0 24 24"><path d=${ICON_ACKNOWLEDGE} /></svg>
                </button>
              </div>
            `
          : nothing}
      </div>
    `
  }
}

customElements.define('alert-banner', AlertBanner)
