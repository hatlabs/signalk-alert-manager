/**
 * AlertCard - Individual alert display component.
 *
 * Shows priority color bar, message, state badge, category tag,
 * time since raised, and stale indicator.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../../types.js'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATE_LABELS } from '../styles/priority.js'

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
      flex-direction: column;
      gap: 0.375rem;
      padding: 0.75rem;
      justify-content: center;
    }

    .actions button {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #fff;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      white-space: nowrap;
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

  updated(changed: Map<string, unknown>): void {
    if (changed.has('alert')) {
      this.actionInFlight = false
      if (this.safetyTimer !== null) {
        clearTimeout(this.safetyTimer)
        this.safetyTimer = null
      }
    }
  }

  private onAcknowledge(): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, 5000)
    this.dispatchEvent(
      new CustomEvent('alert-acknowledge', {
        detail: { id: this.alert.id },
        bubbles: true,
        composed: true
      })
    )
  }

  private onSilence(): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, 5000)
    this.dispatchEvent(
      new CustomEvent('alert-silence', {
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
    const showAck = isUnacked && this.alert.priority !== 'caution'
    const showSilence = isUnacked && !this.alert.silenced
    const hasActions = showAck || showSilence

    return html`
      <div
        class="card ${isUnacked ? 'flashing' : ''}"
        style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
      >
        <div class="priority-bar"></div>
        <div class="content">
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
                      ?disabled=${this.actionInFlight}
                      @click=${this.onAcknowledge}
                    >
                      Acknowledge
                    </button>`
                  : nothing}
                ${showSilence
                  ? html`<button
                      data-action="silence"
                      ?disabled=${this.actionInFlight}
                      @click=${this.onSilence}
                    >
                      Silence
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

function formatTime(iso: string): string {
  const date = new Date(iso)
  return isNaN(date.getTime()) ? iso : date.toLocaleString()
}
