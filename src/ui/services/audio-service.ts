/**
 * AudioService
 *
 * Synthesizes alert tones using the Web Audio API.
 * Different frequencies and patterns per IMO priority level:
 * - Emergency: continuous high tone (880 Hz)
 * - Alarm: continuous medium tone (660 Hz)
 * - Warning: momentary low tone (440 Hz, 1.5s)
 * - Caution: no audible indicator
 *
 * Handles browser autoplay policy by deferring AudioContext creation
 * until the first user gesture on the document.
 */

import type { Alert, AlertPriority } from '../../types.js'
import { PRIORITY_ORDER } from '../styles/priority.js'

interface AudioServiceOptions {
  enabled?: boolean
}

/** Frequency in Hz for each audible priority level. */
const TONE_FREQUENCIES: Partial<Record<AlertPriority, number>> = {
  emergency: 880,
  alarm: 660,
  warning: 440
}

/** Duration in ms for momentary tones (warning). 0 = continuous. */
const TONE_DURATION: Partial<Record<AlertPriority, number>> = {
  emergency: 0,
  alarm: 0,
  warning: 1500
}

const DEFAULT_GAIN = 0.3

export class AudioService {
  private enabled: boolean
  private audioCtx: AudioContext | null = null
  private currentOscillator: OscillatorNode | null = null
  private currentGain: GainNode | null = null
  private currentPriority: AlertPriority | null = null
  private momentaryTimer: ReturnType<typeof setTimeout> | null = null
  private lastAlerts: Alert[] = []
  private userHasInteracted = false
  private gestureHandler: (() => void) | null = null

  constructor(options?: AudioServiceOptions) {
    this.enabled = options?.enabled !== false
    this.listenForUserGesture()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.stopTone()
    } else {
      this.evaluate(this.lastAlerts)
    }
  }

  /**
   * Evaluate the current alert set and play the appropriate tone.
   * Called whenever alerts change.
   */
  update(alerts: Alert[]): void {
    this.lastAlerts = alerts
    this.evaluate(alerts)
  }

  dispose(): void {
    this.removeGestureListener()
    this.stopTone()
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close()
    }
  }

  /**
   * Listen for a user gesture to unlock the AudioContext.
   * Browsers block audio playback until the user interacts with the page.
   */
  private listenForUserGesture(): void {
    if (typeof document === 'undefined') return

    this.gestureHandler = () => {
      this.userHasInteracted = true
      this.removeGestureListener()
      // Re-evaluate: if alerts were waiting for audio, start playing now
      this.evaluate(this.lastAlerts)
    }

    for (const event of ['click', 'touchstart', 'keydown'] as const) {
      document.addEventListener(event, this.gestureHandler, { once: true, capture: true })
    }
  }

  private removeGestureListener(): void {
    if (!this.gestureHandler || typeof document === 'undefined') return

    for (const event of ['click', 'touchstart', 'keydown'] as const) {
      document.removeEventListener(event, this.gestureHandler, { capture: true })
    }
    this.gestureHandler = null
  }

  private evaluate(alerts: Alert[]): void {
    if (!this.enabled) {
      return
    }

    // Find the highest-priority unacknowledged, unsilenced alert
    const audibleAlert = this.findHighestAudibleAlert(alerts)

    if (!audibleAlert) {
      this.stopTone()
      return
    }

    const freq = TONE_FREQUENCIES[audibleAlert.priority]
    if (freq === undefined) {
      // Caution — no audible
      this.stopTone()
      return
    }

    // Can't play until user has interacted with the page
    if (!this.userHasInteracted) {
      return
    }

    // If already playing the same priority, don't restart
    if (this.currentPriority === audibleAlert.priority && this.currentOscillator) {
      return
    }

    // Stop any existing tone and start the new one
    this.stopTone()
    this.playTone(audibleAlert.priority, freq)
  }

  private findHighestAudibleAlert(alerts: Alert[]): Alert | null {
    let best: Alert | null = null
    for (const alert of alerts) {
      const isUnacked = alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
      if (!isUnacked || alert.silenced) {
        continue
      }
      if (!best || PRIORITY_ORDER[alert.priority] < PRIORITY_ORDER[best.priority]) {
        best = alert
      }
    }
    return best
  }

  private ensureContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext()
    }
    return this.audioCtx
  }

  private playTone(priority: AlertPriority, frequency: number): void {
    const ctx = this.ensureContext()

    // Resume if suspended — the context is created after user gesture,
    // so resume() should succeed immediately.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // If resume fails, we can't play audio. The next evaluate()
        // will try again.
      })
    }

    const gain = ctx.createGain()
    gain.gain.value = DEFAULT_GAIN
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = frequency
    osc.connect(gain)
    osc.start()

    this.currentOscillator = osc
    this.currentGain = gain
    this.currentPriority = priority

    const duration = TONE_DURATION[priority]
    if (duration && duration > 0) {
      this.momentaryTimer = setTimeout(() => {
        this.stopTone()
      }, duration)
    }
  }

  private stopTone(): void {
    if (this.momentaryTimer !== null) {
      clearTimeout(this.momentaryTimer)
      this.momentaryTimer = null
    }

    if (this.currentOscillator) {
      try {
        this.currentOscillator.stop()
      } catch {
        // Already stopped
      }
      this.currentOscillator.disconnect()
      this.currentOscillator = null
    }

    if (this.currentGain) {
      this.currentGain.disconnect()
      this.currentGain = null
    }

    this.currentPriority = null
  }
}
