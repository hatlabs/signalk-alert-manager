/**
 * AlertList and AlertCard Component Tests
 *
 * Tests component rendering with happy-dom environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: crypto.randomUUID(),
    sourceId: 'test',
    priority: 'warning',
    state: 'unacknowledged',
    condition: true,
    latching: false,
    silenced: false,
    message: 'Test alert',
    raisedAt: new Date().toISOString(),
    sourceOnline: true,
    lastSourceUpdate: new Date().toISOString(),
    stale: false,
    ...overrides
  }
}

/** Wait for Lit to finish rendering. */
async function updateComplete(el: { updateComplete: Promise<boolean> }): Promise<void> {
  await el.updateComplete
}

/** Query inside shadow DOM. */
function shadowQuery(el: Element, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null
}

function shadowQueryAll(el: Element, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? [])
}

// ---------------------------------------------------------------------------
// AlertCard
// ---------------------------------------------------------------------------

describe('AlertCard', () => {
  beforeEach(async () => {
    await import('../../../src/ui/components/alert-card.js')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders alert message', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ message: 'Engine coolant high' })
    document.body.appendChild(el)
    await updateComplete(el)

    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Engine coolant high')
  })

  it('shows priority label', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ priority: 'alarm' })
    document.body.appendChild(el)
    await updateComplete(el)

    const priority = shadowQuery(el, '.priority')
    expect(priority?.textContent).toContain('Alarm')
  })

  it('shows state badge', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'acknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const state = shadowQuery(el, '.state')
    expect(state?.textContent).toContain('Acknowledged')
  })

  it('shows category when present', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ category: 'engine' })
    document.body.appendChild(el)
    await updateComplete(el)

    const category = shadowQuery(el, '.category')
    expect(category?.textContent).toContain('engine')
  })

  it('does not show category when absent', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ category: undefined })
    document.body.appendChild(el)
    await updateComplete(el)

    const category = shadowQuery(el, '.category')
    expect(category).toBeNull()
  })

  it('applies priority color via CSS custom property', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ priority: 'emergency' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card).not.toBeNull()
    // The component should set --priority-color CSS variable
    const style = (card as HTMLElement)?.style
    expect(style.getPropertyValue('--priority-color')).toBeTruthy()
  })

  it('shows stale indicator when alert is stale', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ stale: true })
    document.body.appendChild(el)
    await updateComplete(el)

    const stale = shadowQuery(el, '.stale')
    expect(stale).not.toBeNull()
  })

  it('has flashing class for unacknowledged state', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'unacknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card?.classList.contains('flashing')).toBe(true)
  })

  it('does not flash for acknowledged state', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'acknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card?.classList.contains('flashing')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AlertList
// ---------------------------------------------------------------------------

describe('AlertList', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // Mock fetch and WebSocket since AlertList connects to AlertService
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen: (() => void) | null = null
        onmessage: (() => void) | null = null
        onclose: (() => void) | null = null
        onerror: (() => void) | null = null
        close(): void {
          /* noop */
        }
        send(): void {
          /* noop */
        }
      }
    )

    await import('../../../src/ui/components/alert-card.js')
    await import('../../../src/ui/components/alert-list.js')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('renders empty state when no alerts', async () => {
    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)
    // Allow the service connect promise to resolve
    await new Promise((r) => setTimeout(r, 0))
    await updateComplete(el)

    const empty = shadowQuery(el, '.empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No alerts')
  })

  it('renders alert cards for each alert', async () => {
    const alerts = [
      makeAlert({ id: '1', message: 'Alert one' }),
      makeAlert({ id: '2', message: 'Alert two' }),
      makeAlert({ id: '3', message: 'Alert three' })
    ]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(alerts)
    })

    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)
    await new Promise((r) => setTimeout(r, 0))
    await updateComplete(el)

    const cards = shadowQueryAll(el, 'alert-card')
    expect(cards).toHaveLength(3)
  })

  it('has filter controls for state and priority', async () => {
    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)

    const stateFilter = shadowQuery(el, '[data-filter="state"]')
    const priorityFilter = shadowQuery(el, '[data-filter="priority"]')
    expect(stateFilter).not.toBeNull()
    expect(priorityFilter).not.toBeNull()
  })

  it('has sort controls', async () => {
    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)

    const sortControl = shadowQuery(el, '[data-sort]')
    expect(sortControl).not.toBeNull()
  })
})
