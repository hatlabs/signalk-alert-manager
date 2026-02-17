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
    alert: { type: Object }
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
  `

  declare alert: Alert

  render() {
    if (!this.alert) {
      return nothing
    }

    const colors = PRIORITY_COLORS[this.alert.priority]
    const isFlashing =
      this.alert.state === 'unacknowledged' || this.alert.state === 'rtn-unacknowledged'

    return html`
      <div
        class="card ${isFlashing ? 'flashing' : ''}"
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
          </div>
          <div class="message">${this.alert.message}</div>
          <div class="time">${formatTime(this.alert.raisedAt)}</div>
        </div>
      </div>
    `
  }
}

customElements.define('alert-card', AlertCard)

function formatTime(iso: string): string {
  try {
    const date = new Date(iso)
    return date.toLocaleString()
  } catch {
    return iso
  }
}
