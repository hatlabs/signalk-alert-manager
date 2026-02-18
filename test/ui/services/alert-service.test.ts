/**
 * AlertService Tests
 *
 * Tests for the UI data layer that fetches alerts from the REST API
 * and subscribes to real-time updates via Signal K WebSocket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AlertService } from '../../../src/ui/services/alert-service.js'
import type { Alert, AlertState } from '../../../src/types.js'

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

/** Captured WebSocket instances for test control. */
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertService', () => {
  let service: AlertService
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    wsInstances = []
    vi.stubGlobal('WebSocket', MockWebSocket)

    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Default: return empty alerts array
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })

    service = new AlertService()
  })

  afterEach(() => {
    service.disconnect()
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // Initial fetch
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    it('fetches alerts from REST API on connect', async () => {
      const alerts = [makeAlert({ message: 'Engine hot' }), makeAlert({ message: 'Low fuel' })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      await service.connect()

      expect(fetchMock).toHaveBeenCalledWith('/plugins/signalk-alert-manager/alerts')
      expect(service.getAlerts()).toHaveLength(2)
    })

    it('dispatches change event after initial fetch', async () => {
      const alerts = [makeAlert()]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      await service.connect()

      expect(onChange).toHaveBeenCalled()
    })

    it('opens WebSocket connection after initial fetch', async () => {
      await service.connect()

      expect(wsInstances).toHaveLength(1)
      expect(wsInstances[0].url).toContain('/signalk/v1/stream')
    })

    it('subscribes to alerts.active.* on WebSocket open', async () => {
      await service.connect()

      const ws = wsInstances[0]
      ws.simulateOpen()

      expect(ws.sent).toHaveLength(1)
      const subscription = JSON.parse(ws.sent[0])
      expect(subscription.context).toBe('vessels.self')
      expect(subscription.subscribe).toContainEqual(
        expect.objectContaining({ path: 'alerts.active.*' })
      )
    })

    it('handles fetch failure gracefully', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'))

      await expect(service.connect()).rejects.toThrow('Network error')
      expect(service.getAlerts()).toHaveLength(0)
    })

    it('handles non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable'
      })

      await expect(service.connect()).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // WebSocket real-time updates
  // -------------------------------------------------------------------------

  describe('WebSocket updates', () => {
    let existingAlert: Alert

    beforeEach(async () => {
      existingAlert = makeAlert({ id: 'alert-1', message: 'Existing', priority: 'warning' })
      const alertResponse = {
        ok: true,
        json: () => Promise.resolve([existingAlert])
      }
      // First call: initial connect; second call: re-sync on WebSocket open
      fetchMock.mockResolvedValueOnce(alertResponse).mockResolvedValueOnce(alertResponse)

      await service.connect()
      wsInstances[0].simulateOpen()
      // Let the re-fetch promise in onopen settle
      await new Promise((r) => setTimeout(r, 0))
    })

    it('adds new alert from delta', () => {
      const newAlert = makeAlert({ id: 'alert-2', message: 'New alert' })

      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.active.alert-2', value: newAlert }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(2)
      expect(onChange).toHaveBeenCalled()
    })

    it('updates existing alert from delta', () => {
      const updated = { ...existingAlert, state: 'acknowledged' as AlertState }

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.active.alert-1', value: updated }]
          }
        ]
      })

      const alerts = service.getAlerts()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].state).toBe('acknowledged')
    })

    it('removes alert when delta value is null (cleared)', () => {
      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.active.alert-1', value: null }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(0)
    })

    it('ignores deltas for non-alert paths', () => {
      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'something' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'navigation.position', value: { latitude: 60, longitude: 25 } }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(1)
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  describe('getAlerts() filtering', () => {
    const alerts = [
      makeAlert({
        id: '1',
        priority: 'emergency',
        state: 'unacknowledged',
        category: 'engine'
      }),
      makeAlert({ id: '2', priority: 'alarm', state: 'acknowledged', category: 'engine' }),
      makeAlert({
        id: '3',
        priority: 'warning',
        state: 'unacknowledged',
        category: 'navigation'
      }),
      makeAlert({ id: '4', priority: 'caution', state: 'acknowledged', category: 'navigation' })
    ]

    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })
      await service.connect()
    })

    it('returns all alerts when no filter', () => {
      expect(service.getAlerts()).toHaveLength(4)
    })

    it('filters by single state', () => {
      const result = service.getAlerts({ state: 'unacknowledged' })
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.state === 'unacknowledged')).toBe(true)
    })

    it('filters by multiple states', () => {
      const result = service.getAlerts({ state: ['unacknowledged', 'acknowledged'] })
      expect(result).toHaveLength(4)
    })

    it('filters by single priority', () => {
      const result = service.getAlerts({ priority: 'emergency' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('1')
    })

    it('filters by multiple priorities', () => {
      const result = service.getAlerts({ priority: ['emergency', 'alarm'] })
      expect(result).toHaveLength(2)
    })

    it('filters by category', () => {
      const result = service.getAlerts({ category: 'engine' })
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.category === 'engine')).toBe(true)
    })

    it('combines filters (AND logic)', () => {
      const result = service.getAlerts({ state: 'unacknowledged', category: 'engine' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('1')
    })
  })

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  describe('getAlerts() sorting', () => {
    const now = Date.now()

    // IMO MSC.302(87) §9.16 default: state → priority → oldest first
    describe('standard sort (default)', () => {
      const alerts = [
        makeAlert({
          id: 'acked-warn',
          priority: 'warning',
          state: 'acknowledged',
          raisedAt: new Date(now - 1000).toISOString()
        }),
        makeAlert({
          id: 'unacked-caution',
          priority: 'caution',
          state: 'unacknowledged',
          raisedAt: new Date(now - 2000).toISOString()
        }),
        makeAlert({
          id: 'unacked-emergency',
          priority: 'emergency',
          state: 'unacknowledged',
          raisedAt: new Date(now - 3000).toISOString()
        }),
        makeAlert({
          id: 'rtn-unacked',
          priority: 'alarm',
          state: 'rtn-unacknowledged',
          raisedAt: new Date(now - 4000).toISOString()
        }),
        makeAlert({
          id: 'acked-emergency',
          priority: 'emergency',
          state: 'acknowledged',
          raisedAt: new Date(now - 5000).toISOString()
        })
      ]

      beforeEach(async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(alerts)
        })
        await service.connect()
      })

      it('places unacknowledged alerts before acknowledged', () => {
        const result = service.getAlerts()
        const ackedIdx = result.findIndex((a) => a.state === 'acknowledged')
        const lastUnackedIdx = result.findLastIndex(
          (a) => a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged'
        )
        expect(lastUnackedIdx).toBeLessThan(ackedIdx)
      })

      it('treats rtn-unacknowledged the same as unacknowledged', () => {
        const result = service.getAlerts()
        const rtnIdx = result.findIndex((a) => a.id === 'rtn-unacked')
        const firstAckedIdx = result.findIndex((a) => a.state === 'acknowledged')
        expect(rtnIdx).toBeLessThan(firstAckedIdx)
      })

      it('sorts by priority within each state group', () => {
        const result = service.getAlerts()
        // Unacked group: emergency, alarm (rtn), caution
        const unackedGroup = result.filter(
          (a) => a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged'
        )
        expect(unackedGroup.map((a) => a.priority)).toEqual(['emergency', 'alarm', 'caution'])
      })

      it('sorts oldest first within same state and priority', () => {
        // Add two unacked alarms at different times
        const twoAlarms = [
          makeAlert({
            id: 'newer-alarm',
            priority: 'alarm',
            state: 'unacknowledged',
            raisedAt: new Date(now - 1000).toISOString()
          }),
          makeAlert({
            id: 'older-alarm',
            priority: 'alarm',
            state: 'unacknowledged',
            raisedAt: new Date(now - 5000).toISOString()
          })
        ]
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(twoAlarms)
        })

        const service2 = new AlertService()
        return service2.connect().then(() => {
          const result = service2.getAlerts()
          expect(result.map((a) => a.id)).toEqual(['older-alarm', 'newer-alarm'])
          service2.disconnect()
        })
      })

      it('produces full IMO-compliant ordering', () => {
        const result = service.getAlerts()
        expect(result.map((a) => a.id)).toEqual([
          'unacked-emergency', // unacked, highest priority, oldest
          'rtn-unacked', // unacked (rtn), alarm
          'unacked-caution', // unacked, lowest priority
          'acked-emergency', // acked, highest priority
          'acked-warn' // acked, lower priority
        ])
      })
    })

    describe('newest sort', () => {
      const alerts = [
        makeAlert({ id: 'old', raisedAt: new Date(now - 3000).toISOString() }),
        makeAlert({ id: 'new', raisedAt: new Date(now - 1000).toISOString() }),
        makeAlert({ id: 'mid', raisedAt: new Date(now - 2000).toISOString() })
      ]

      beforeEach(async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(alerts)
        })
        await service.connect()
      })

      it('sorts newest first regardless of state or priority', () => {
        const result = service.getAlerts(undefined, 'newest')
        expect(result.map((a) => a.id)).toEqual(['new', 'mid', 'old'])
      })
    })
  })

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  describe('disconnect()', () => {
    it('closes WebSocket connection', async () => {
      await service.connect()
      const ws = wsInstances[0]
      ws.simulateOpen()

      service.disconnect()

      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    })

    it('clears alerts', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makeAlert()])
      })
      await service.connect()

      expect(service.getAlerts()).toHaveLength(1)

      service.disconnect()

      expect(service.getAlerts()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  describe('WebSocket reconnection', () => {
    it('attempts reconnect after unexpected close', async () => {
      vi.useFakeTimers()

      await service.connect()
      const ws1 = wsInstances[0]
      ws1.simulateOpen()

      // Simulate unexpected close
      ws1.simulateClose()

      // Advance past reconnect delay
      vi.advanceTimersByTime(1500)

      expect(wsInstances).toHaveLength(2)

      vi.useRealTimers()
    })

    it('does not reconnect after explicit disconnect', async () => {
      vi.useFakeTimers()

      await service.connect()
      wsInstances[0].simulateOpen()

      service.disconnect()

      vi.advanceTimersByTime(5000)

      // Only the original WebSocket, no reconnect attempts
      expect(wsInstances).toHaveLength(1)

      vi.useRealTimers()
    })
  })
})
