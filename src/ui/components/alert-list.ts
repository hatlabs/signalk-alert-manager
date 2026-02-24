/**
 * AlertList - Main alert list component.
 *
 * Connects to AlertService for real-time data and renders alert-card
 * elements for each alert.
 */

import { LitElement, html, css } from 'lit'
import type { Alert } from '../../types.js'
import { AlertService } from '../services/alert-service.js'

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true }
  }

  static styles = css`
    :host {
      display: block;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #e0e0e0;
    }

    .alert-count {
      font-size: 0.85rem;
      font-weight: 600;
      color: #444;
    }

    button[data-action='silence-all'] {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem 0.75rem;
      border: 1px solid #1976d2;
      border-radius: 4px;
      background: #fff;
      color: #1565c0;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      white-space: nowrap;
    }

    button[data-action='silence-all']:hover:not(:disabled) {
      background: #e3f2fd;
    }

    button[data-action='silence-all']:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .empty {
      text-align: center;
      padding: 2rem;
      color: #888;
      font-size: 0.9rem;
    }

    .list {
      display: flex;
      flex-direction: column;
    }
  `

  declare alerts: Alert[]

  private service = new AlertService()

  constructor() {
    super()
    this.alerts = []
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service.addEventListener('change', this.onServiceChange)
    this.addEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.addEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.service.connect().catch(() => {
      // Connection failure; alerts stay empty until retry succeeds
    })
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.removeEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.removeEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.service.disconnect()
  }

  private onServiceChange = (): void => {
    this.alerts = this.service.getAlerts()
  }

  private onAlertAcknowledge = (e: CustomEvent<{ id: string }>): void => {
    this.service.acknowledgeAlert(e.detail.id).catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  private onAlertSilence = (e: CustomEvent<{ id: string }>): void => {
    this.service.silenceAlert(e.detail.id).catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  /** Check all alerts — silence-all is a global action. */
  private hasUnsilencedUnacknowledged(): boolean {
    return this.service
      .getAlerts()
      .some(
        (a) => (a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged') && !a.silenced
      )
  }

  private onSilenceAll(): void {
    this.service.silenceAll().catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  render() {
    return html`
      <div class="toolbar">
        <span class="alert-count"
          >${String(this.alerts.length)} alert${this.alerts.length !== 1 ? 's' : ''}</span
        >
        <button
          data-action="silence-all"
          ?disabled=${!this.hasUnsilencedUnacknowledged()}
          @click=${this.onSilenceAll}
        >
          Silence All
        </button>
      </div>

      ${this.alerts.length === 0
        ? html`<div class="empty">No alerts</div>`
        : html`
            <div class="list">
              ${this.alerts.map((alert) => html`<alert-card .alert=${alert}></alert-card>`)}
            </div>
          `}
    `
  }
}

customElements.define('alert-list', AlertList)
