import { LitElement, html, css } from 'lit'

export class AlertApp extends LitElement {
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

  render() {
    return html`
      <h1>Alert Manager</h1>
      <alert-banner></alert-banner>
      <alert-list></alert-list>
    `
  }
}

customElements.define('alert-app', AlertApp)
