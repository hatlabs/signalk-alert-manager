/**
 * AlertApp - Root application component.
 *
 * Manages navigation between the alert list and detail views.
 * Renders alert-banner persistently, and switches between
 * alert-list and alert-detail based on user selection.
 */

import { LitElement, html, css } from 'lit'

export class AlertApp extends LitElement {
  static properties = {
    selectedAlertId: { state: true }
  }

  static styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      padding: 1rem;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.25rem;
      color: #333;
    }
  `

  declare selectedAlertId: string | null

  constructor() {
    super()
    this.selectedAlertId = null
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.addEventListener('alert-select', this.onAlertSelect as EventListener)
    this.addEventListener('alert-detail-close', this.onDetailClose)
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.removeEventListener('alert-select', this.onAlertSelect as EventListener)
    this.removeEventListener('alert-detail-close', this.onDetailClose)
  }

  private onAlertSelect = (e: CustomEvent<{ id: string }>): void => {
    this.selectedAlertId = e.detail.id
  }

  private onDetailClose = (): void => {
    this.selectedAlertId = null
  }

  render() {
    return html`
      <h1>Alert Manager</h1>
      <alert-banner></alert-banner>
      ${this.selectedAlertId
        ? html`<alert-detail alert-id=${this.selectedAlertId}></alert-detail>`
        : html`<alert-list></alert-list>`}
    `
  }
}

customElements.define('alert-app', AlertApp)
