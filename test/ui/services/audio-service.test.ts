/**
 * AudioService Tests
 *
 * Tests for browser audio playback of alert notifications.
 * Uses Web Audio API synthesis with different tones per priority level.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert, AlertPriority } from '../../../src/types.js'

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

/** Simulate a user gesture to unlock AudioContext. */
function simulateUserGesture(): void {
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Mock Web Audio API
// ---------------------------------------------------------------------------

class MockOscillatorNode {
  type = 'sine'
  frequency = { value: 0 }
  started = false
  stopped = false
  connectedTo: MockGainNode | null = null

  connect(destination: MockGainNode): void {
    this.connectedTo = destination
  }

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }

  disconnect(): void {
    this.connectedTo = null
  }
}

class MockGainNode {
  gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  connectedTo: unknown = null

  connect(destination: unknown): void {
    this.connectedTo = destination
  }

  disconnect(): void {
    this.connectedTo = null
  }
}

class MockAudioContext {
  state = 'running' as AudioContextState
  destination = {}
  currentTime = 0

  oscillators: MockOscillatorNode[] = []
  gainNodes: MockGainNode[] = []

  createOscillator(): MockOscillatorNode {
    const osc = new MockOscillatorNode()
    this.oscillators.push(osc)
    return osc
  }

  createGain(): MockGainNode {
    const gain = new MockGainNode()
    this.gainNodes.push(gain)
    return gain
  }

  resume(): Promise<void> {
    this.state = 'running' as AudioContextState
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed' as AudioContextState
    return Promise.resolve()
  }
}

let mockAudioContext: MockAudioContext

beforeEach(() => {
  mockAudioContext = new MockAudioContext()
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return mockAudioContext
      }
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Lazy import after mocks are set up
// ---------------------------------------------------------------------------

async function importAudioService() {
  // Dynamic import so mocks are in place first
  const mod = await import('../../../src/ui/services/audio-service.js')
  return mod.AudioService
}

/** Create a service and simulate a user gesture so audio is unlocked. */
async function createUnlockedService(options?: { enabled?: boolean }) {
  const AudioService = await importAudioService()
  const service = new AudioService(options)
  simulateUserGesture()
  return service
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudioService', () => {
  describe('construction', () => {
    it('starts with audio enabled', async () => {
      const service = await createUnlockedService()
      expect(service.isEnabled()).toBe(true)
      service.dispose()
    })

    it('can be constructed with audio disabled', async () => {
      const service = await createUnlockedService({ enabled: false })
      expect(service.isEnabled()).toBe(false)
      service.dispose()
    })
  })

  describe('user gesture gating', () => {
    it('does not play audio before user gesture', async () => {
      const AudioService = await importAudioService()
      const service = new AudioService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      // No oscillator created — waiting for user gesture
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('starts playing after user gesture when alerts are waiting', async () => {
      const AudioService = await importAudioService()
      const service = new AudioService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      // User interacts with the page
      simulateUserGesture()

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      expect(mockAudioContext.oscillators[0].started).toBe(true)

      service.dispose()
    })

    it('plays immediately if user has already interacted', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('enable/disable', () => {
    it('setEnabled(false) stops any playing tone', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.setEnabled(false)
      expect(service.isEnabled()).toBe(false)
      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('setEnabled(true) re-evaluates alerts and plays if needed', async () => {
      const service = await createUnlockedService({ enabled: false })

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.setEnabled(true)
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('priority tones', () => {
    it('plays continuous tone for emergency', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({ priority: 'emergency', state: 'unacknowledged', silenced: false })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)
      expect(osc.frequency.value).toBeGreaterThan(600)

      service.dispose()
    })

    it('plays tone for alarm', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)

      service.dispose()
    })

    it('plays momentary tone for warning', async () => {
      vi.useFakeTimers()
      const AudioService = await importAudioService()
      const service = new AudioService()
      simulateUserGesture()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)

      // After momentary duration, oscillator should stop
      vi.advanceTimersByTime(2000)
      expect(osc.stopped).toBe(true)

      vi.useRealTimers()
      service.dispose()
    })

    it('does not play audio for caution', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'caution', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('uses different frequencies for different priorities', async () => {
      const AudioService = await importAudioService()
      const frequencies: Record<string, number> = {}

      for (const priority of ['emergency', 'alarm', 'warning'] as AlertPriority[]) {
        mockAudioContext = new MockAudioContext()
        const svc = new AudioService()
        simulateUserGesture()
        svc.update([makeAlert({ priority, state: 'unacknowledged', silenced: false })])

        if (mockAudioContext.oscillators.length > 0) {
          frequencies[priority] = mockAudioContext.oscillators[0].frequency.value
        }
        svc.dispose()
      }

      expect(frequencies['emergency']).toBeGreaterThan(frequencies['alarm']!)
      expect(frequencies['alarm']).toBeGreaterThan(frequencies['warning']!)
    })
  })

  describe('silence state', () => {
    it('does not play for silenced alerts', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: true })])

      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('stops playing when alert becomes silenced', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })
      service.update([alert])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)

      service.update([{ ...alert, silenced: true }])

      expect(osc.stopped).toBe(true)

      service.dispose()
    })

    it('resumes audio when silence expires (alert becomes unsilenced)', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: true })
      service.update([alert])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.update([{ ...alert, silenced: false }])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('alert state changes', () => {
    it('stops playing when alert is acknowledged', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })
      service.update([alert])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.update([{ ...alert, state: 'acknowledged' }])

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('stops playing when alert is removed (cleared)', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.update([])

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('plays for rtn-unacknowledged alerts', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({ priority: 'alarm', state: 'rtn-unacknowledged', silenced: false })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('highest priority selection', () => {
    it('plays tone for highest unsilenced priority', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({
          id: 'e1',
          priority: 'emergency',
          state: 'unacknowledged',
          silenced: true
        }),
        makeAlert({
          id: 'a1',
          priority: 'alarm',
          state: 'unacknowledged',
          silenced: false
        })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })

    it('upgrades tone when higher-priority alert arrives', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])
      const warningFreq = mockAudioContext.oscillators[0]?.frequency.value ?? 0

      service.update([
        makeAlert({ id: 'w1', priority: 'warning', state: 'unacknowledged', silenced: false }),
        makeAlert({ id: 'a1', priority: 'alarm', state: 'unacknowledged', silenced: false })
      ])

      const latestOsc = mockAudioContext.oscillators[mockAudioContext.oscillators.length - 1]
      expect(latestOsc.frequency.value).toBeGreaterThan(warningFreq)

      service.dispose()
    })
  })

  describe('dispose', () => {
    it('stops all audio and closes context', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      service.dispose()

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }
      expect(mockAudioContext.state).toBe('closed')
    })

    it('is idempotent', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      service.dispose()
      // Should not throw
      service.dispose()

      expect(mockAudioContext.state).toBe('closed')
    })
  })
})
