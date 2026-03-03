/**
 * AlertCard - Individual alert display component.
 *
 * Shows priority color bar, message, state badge, category tag,
 * time since raised, and stale indicator.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../../types.js'
import { ICON_ACKNOWLEDGE, ICON_SILENCE } from '../styles/icons.js'
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

    .priority-bar {
      width: 6px;
      flex-shrink: 0;
      background: var(--priority-color, #666);
    }

    .card.flashing .priority-bar {
      animation: bar-pulse 1s ease-in-out infinite;
    }

    @keyframes bar-pulse {
      0%,
      100% {
        box-shadow: inset 0 0 0 0 var(--priority-color, #666);
      }
      50% {
        box-shadow: inset 0 0 8px 3px var(--priority-color, #666);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .card.flashing .priority-bar {
        animation: none;
      }
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
                ${showSilence
                  ? html`<button
                      data-action="silence"
                      title="Silence"
                      aria-label="Silence: ${this.alert.message}"
                      ?disabled=${this.actionInFlight}
                      @click=${this.onSilence}
                    >
                      <svg viewBox="0 0 24 24"><path d=${ICON_SILENCE} /></svg>
                    </button>`
                  : nothing}
                ${showAck
                  ? html`<button
                      data-action="acknowledge"
                      title="Acknowledge"
                      aria-label="Acknowledge: ${this.alert.message}"
                      ?disabled=${this.actionInFlight}
                      @click=${this.onAcknowledge}
                    >
                      <svg viewBox="0 0 24 24"><path d=${ICON_ACKNOWLEDGE} /></svg>
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
