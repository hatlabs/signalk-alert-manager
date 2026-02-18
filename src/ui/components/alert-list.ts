/**
 * AlertList - Main alert list component with filtering and sorting.
 *
 * Connects to AlertService for real-time data and renders alert-card
 * elements for each alert.
 */

import { LitElement, html, css } from 'lit'
import type { Alert, AlertFilter, AlertPriority, AlertState } from '../../types.js'
import { AlertService, type SortBy } from '../services/alert-service.js'

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true },
    filterState: { state: true },
    filterPriority: { state: true },
    filterCategory: { state: true },
    sortBy: { state: true }
  }

  static styles = css`
    :host {
      display: block;
    }

    .controls {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .control-group label {
      font-size: 0.8rem;
      font-weight: 600;
      color: #555;
    }

    select,
    input {
      font-size: 0.8rem;
      padding: 0.25rem 0.5rem;
      border: 1px solid #ccc;
      border-radius: 4px;
    }

    .alert-count {
      font-size: 0.8rem;
      color: #666;
    }

    .controls-right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-left: auto;
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
  declare filterState: AlertState | ''
  declare filterPriority: AlertPriority | ''
  declare filterCategory: string
  declare sortBy: SortBy

  private service = new AlertService()

  constructor() {
    super()
    this.alerts = []
    this.filterState = ''
    this.filterPriority = ''
    this.filterCategory = ''
    this.sortBy = 'standard'
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
    this.updateAlerts()
  }

  private updateAlerts(): void {
    const filter: AlertFilter = {}
    if (this.filterState) filter.state = this.filterState
    if (this.filterPriority) filter.priority = this.filterPriority
    if (this.filterCategory) filter.category = this.filterCategory

    this.alerts = this.service.getAlerts(
      Object.keys(filter).length > 0 ? filter : undefined,
      this.sortBy
    )
  }

  private onStateFilterChange(e: Event): void {
    this.filterState = (e.target as HTMLSelectElement).value as AlertState | ''
    this.updateAlerts()
  }

  private onPriorityFilterChange(e: Event): void {
    this.filterPriority = (e.target as HTMLSelectElement).value as AlertPriority | ''
    this.updateAlerts()
  }

  private onCategoryFilterChange(e: Event): void {
    this.filterCategory = (e.target as HTMLInputElement).value
    this.updateAlerts()
  }

  private onSortChange(e: Event): void {
    this.sortBy = (e.target as HTMLSelectElement).value as SortBy
    this.updateAlerts()
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

  /** Check all alerts (unfiltered) — silence-all is a global action. */
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
      <div class="controls">
        <div class="control-group">
          <label for="state-filter">State</label>
          <select
            id="state-filter"
            data-filter="state"
            @change=${this.onStateFilterChange}
            .value=${this.filterState}
          >
            <option value="">All</option>
            <option value="unacknowledged">Unacknowledged</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="rtn-unacknowledged">RTN Unacked</option>
          </select>
        </div>

        <div class="control-group">
          <label for="priority-filter">Priority</label>
          <select
            id="priority-filter"
            data-filter="priority"
            @change=${this.onPriorityFilterChange}
            .value=${this.filterPriority}
          >
            <option value="">All</option>
            <option value="emergency">Emergency</option>
            <option value="alarm">Alarm</option>
            <option value="warning">Warning</option>
            <option value="caution">Caution</option>
          </select>
        </div>

        <div class="control-group">
          <label for="category-filter">Category</label>
          <input
            id="category-filter"
            data-filter="category"
            type="text"
            placeholder="Filter..."
            @input=${this.onCategoryFilterChange}
            .value=${this.filterCategory}
          />
        </div>

        <div class="control-group">
          <label for="sort">Sort</label>
          <select id="sort" data-sort @change=${this.onSortChange} .value=${this.sortBy}>
            <option value="standard">Standard</option>
            <option value="newest">Newest first</option>
          </select>
        </div>

        <div class="controls-right">
          <button
            data-action="silence-all"
            ?disabled=${!this.hasUnsilencedUnacknowledged()}
            @click=${this.onSilenceAll}
          >
            Silence All
          </button>
          <span class="alert-count"
            >${String(this.alerts.length)} alert${this.alerts.length !== 1 ? 's' : ''}</span
          >
        </div>
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
