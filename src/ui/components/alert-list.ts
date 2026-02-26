/**
 * AlertList - Main alert list component.
 *
 * Connects to AlertService for real-time data and renders alert-card
 * elements for each alert.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../../types.js'
import { AlertService } from '../services/alert-service.js'
import { AudioService } from '../services/audio-service.js'
import { VALID_AUDIBLE_PRIORITIES } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'
import { SimulationService } from '../services/simulation-service.js'

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true },
    minAudiblePriority: { state: true },
    simulationRunning: { state: true },
    simulationEnabled: { state: true }
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

    .toolbar-actions {
      display: flex;
      gap: 0.5rem;
    }

    button[data-action='simulate'] {
      min-height: 44px;
      min-width: 44px;
      padding: 0.375rem 0.75rem;
      border: 1px solid #e65100;
      border-radius: 4px;
      background: #fff;
      color: #e65100;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      white-space: nowrap;
    }

    button[data-action='simulate']:hover {
      background: #fff3e0;
    }

    button[data-action='simulate'].sim-active {
      background: #e65100;
      color: #fff;
    }

    button[data-action='simulate'].sim-active:hover {
      background: #bf360c;
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

    .group-separator {
      height: 0;
      border: none;
      border-top: 1px solid #ccc;
      margin: 0.5rem 0;
    }
  `

  declare alerts: Alert[]
  declare minAudiblePriority: MinAudiblePriority | null
  declare simulationRunning: boolean
  declare simulationEnabled: boolean

  private service = new AlertService()
  private audioService = new AudioService()
  private simulation = new SimulationService(() => this.service.getAlerts())

  constructor() {
    super()
    this.alerts = []
    this.minAudiblePriority = null
    this.simulationRunning = false
    this.simulationEnabled = false
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service.addEventListener('change', this.onServiceChange)
    this.addEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.addEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.service.connect().catch(() => {
      // Connection failure; alerts stay empty until retry succeeds
    })
    this.fetchUiConfig()
  }

  private fetchUiConfig(): void {
    fetch('/plugins/signalk-alert-manager/config/ui')
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              minAudiblePriority?: string
              enableSimulation?: boolean
            }>)
          : null
      )
      .then((config) => {
        if (config?.minAudiblePriority && VALID_AUDIBLE_PRIORITIES.has(config.minAudiblePriority)) {
          const priority = config.minAudiblePriority as MinAudiblePriority
          this.audioService.setMinAudiblePriority(priority)
          this.minAudiblePriority = priority
        }
        if (config?.enableSimulation === true) {
          this.simulationEnabled = true
        }
      })
      .catch(() => {
        // Config fetch failed; defaults apply
      })
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.removeEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.removeEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.simulation.stop()
    this.service.disconnect()
    this.audioService.dispose()
  }

  private onServiceChange = (): void => {
    const alerts = this.service.getAlerts()
    this.alerts = alerts
    this.audioService.update(alerts)
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

  private onToggleSimulation(): void {
    if (this.simulation.running) {
      this.simulation.stop()
    } else {
      this.simulation.start()
    }
    this.simulationRunning = this.simulation.running
  }

  private onSilenceAll(): void {
    this.service.silenceAll().catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  private isUnacked(alert: Alert): boolean {
    return alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
  }

  // Assumes alerts are sorted with all unacked states before acknowledged,
  // per IMO MSC.302(87) default sort (enforced by applySort in alert-service).
  private renderAlertList() {
    const separatorIndex = this.alerts.findIndex(
      (a, i) => !this.isUnacked(a) && i > 0 && this.isUnacked(this.alerts[i - 1])
    )

    return this.alerts.map(
      (alert, i) => html`
        ${i === separatorIndex ? html`<hr class="group-separator" />` : nothing}
        <alert-card .alert=${alert} .minAudiblePriority=${this.minAudiblePriority}></alert-card>
      `
    )
  }

  render() {
    return html`
      <div class="toolbar">
        <span class="alert-count"
          >${String(this.alerts.length)} alert${this.alerts.length !== 1 ? 's' : ''}</span
        >
        <div class="toolbar-actions">
          ${this.simulationEnabled
            ? html`<button
                data-action="simulate"
                class=${this.simulationRunning ? 'sim-active' : ''}
                @click=${this.onToggleSimulation}
              >
                ${this.simulationRunning ? 'Stop Sim' : 'Simulate'}
              </button>`
            : nothing}
          <button
            data-action="silence-all"
            ?disabled=${!this.hasUnsilencedUnacknowledged()}
            @click=${this.onSilenceAll}
          >
            Silence All
          </button>
        </div>
      </div>

      ${this.alerts.length === 0
        ? html`<div class="empty">No alerts</div>`
        : html` <div class="list">${this.renderAlertList()}</div> `}
    `
  }
}

customElements.define('alert-list', AlertList)
