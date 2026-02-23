/**
 * AlertCard - Individual alert display component.
 *
 * Shows priority color bar, message, state badge, category tag,
 * time since raised, and stale indicator.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../../types.js'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATE_LABELS } from '../styles/priority.js'
import { formatTime } from '../utils/format.js'

/** Timeout before re-enabling buttons if no WebSocket update arrives. */
const ACTION_TIMEOUT_MS = 5000

export class AlertCard extends LitElement {
  static properties = {
    alert: { type: Object },
    actionInFlight: { state: true }
  }

  static styles = css`
    :host {
      display: block;
    }

    .card {
      display: flex;
      align-items: stretch;
      border: 2px solid var(--priority-color, #666);
      border-radius: 6px;
      background: var(--priority-bg, #fff);
      margin-bottom: 0.5rem;
      overflow: hidden;
    }

    .card.flashing {
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

    .content {
      flex: 1;
      padding: 0.75rem;
      min-width: 0;
      cursor: pointer;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
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

    .message {
      font-size: 0.9rem;
      color: #222;
      margin-bottom: 0.25rem;
    }

    .time {
      font-size: 0.75rem;
      color: #888;
    }

    .silenced {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      background: #e8eaf6;
      color: #3949ab;
    }

    .actions {
      display: flex;
      flex-direction: row;
      gap: 0.375rem;
      padding: 0.75rem;
      align-items: center;
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

    @media (max-width: 480px) {
      .card {
        flex-wrap: wrap;
      }

      .actions {
        flex-direction: row;
        width: 100%;
        padding: 0 0.75rem 0.75rem;
      }

      .actions button {
        flex: 1;
      }
    }
  `

  declare alert: Alert
  declare actionInFlight: boolean

  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.actionInFlight = false
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.clearSafetyTimer()
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('alert')) {
      this.actionInFlight = false
      this.clearSafetyTimer()
    }
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  private startAction(eventName: string): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    this.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { id: this.alert.id },
        bubbles: true,
        composed: true
      })
    )
  }

  private onAcknowledge(): void {
    this.startAction('alert-acknowledge')
  }

  private onSilence(): void {
    this.startAction('alert-silence')
  }

  private onSelect(): void {
    this.dispatchEvent(
      new CustomEvent('alert-select', {
        detail: { id: this.alert.id },
        bubbles: true,
        composed: true
      })
    )
  }

  render() {
    if (!this.alert) {
      return nothing
    }

    const colors = PRIORITY_COLORS[this.alert.priority]
    const isUnacked =
      this.alert.state === 'unacknowledged' || this.alert.state === 'rtn-unacknowledged'
    const showAck = isUnacked
    const showSilence = isUnacked && !this.alert.silenced
    const hasActions = showAck || showSilence

    return html`
      <div
        class="card ${isUnacked ? 'flashing' : ''}"
        style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
      >
        <div class="priority-bar"></div>
        <div class="content" @click=${this.onSelect}>
          <div class="header">
            <span class="priority">${PRIORITY_LABELS[this.alert.priority]}</span>
            <span class="state">${STATE_LABELS[this.alert.state]}</span>
            ${this.alert.category
              ? html`<span class="category">${this.alert.category}</span>`
              : nothing}
            ${this.alert.stale ? html`<span class="stale">Stale</span>` : nothing}
            ${this.alert.silenced ? html`<span class="silenced">Silenced</span>` : nothing}
          </div>
          <div class="message">${this.alert.message}</div>
          <div class="time">${formatTime(this.alert.raisedAt)}</div>
        </div>
        ${hasActions
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
      </div>
    `
  }
}

customElements.define('alert-card', AlertCard)
