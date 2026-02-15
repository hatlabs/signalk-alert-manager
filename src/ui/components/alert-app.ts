import { LitElement, html, css } from 'lit'
import { customElement } from 'lit/decorators.js'

@customElement('alert-app')
export class AlertApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      padding: 1rem;
    }
    h1 {
      margin: 0 0 1rem 0;
    }
  `

  render() {
    return html`
      <h1>Alert Manager</h1>
      <p>Alert management interface placeholder.</p>
    `
  }
}
