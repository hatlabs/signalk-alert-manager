import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Delta, PathValue } from '@signalk/server-api'
import { DeltaPublisher } from '../../src/integration/DeltaPublisher.js'
import { AlertManager, type AlertManagerConfig } from '../../src/core/AlertManager.js'
import { FakeTimerFunctions } from '../helpers/FakeTimerFunctions.js'

const defaultConfig: AlertManagerConfig = {
  escalation: { enabled: true, timeoutSeconds: 300 },
  silencing: { defaultMaxSilenceSeconds: 120, emergencyMaxSilenceSeconds: 30 },
  sourceTimeout: { markStaleAfterSeconds: 60 }
}

/** Extract values array from the first update in the latest captured delta. */
function getValues(capturedDeltas: { delta: Delta }[]): PathValue[] {
  const update = capturedDeltas[capturedDeltas.length - 1].delta.updates[0]
  return 'values' in update ? update.values : []
}

/** Find a value by path prefix from a PathValue array. */
function findValue(values: PathValue[], pathPrefix: string): PathValue {
  const found = values.find((v) => String(v.path).startsWith(pathPrefix))
  if (!found) {
    throw new Error(`No value found for path prefix: ${pathPrefix}`)
  }
  return found
}

describe('DeltaPublisher', () => {
  let alertManager: AlertManager
  let fakeTimers: FakeTimerFunctions
  let capturedDeltas: { pluginId: string; delta: Delta }[]
  let publisher: DeltaPublisher

  beforeEach(() => {
    fakeTimers = new FakeTimerFunctions()
    alertManager = new AlertManager(defaultConfig, fakeTimers)
    capturedDeltas = []

    publisher = new DeltaPublisher({
      alertManager,
      handleMessage: (pluginId: string, delta: object) => {
        capturedDeltas.push({ pluginId, delta: delta as Delta })
      },
      pluginId: 'signalk-alert-manager'
    })
    publisher.start()
  })

  afterEach(() => {
    publisher.stop()
    alertManager.stop()
  })

  it('should publish delta when alert is raised', async () => {
    await alertManager.raiseAlert({
      path: 'engine.overheating',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Engine overheating',
      category: 'engine'
    })

    expect(capturedDeltas).toHaveLength(1)
    const delta = capturedDeltas[0].delta
    expect(capturedDeltas[0].pluginId).toBe('signalk-alert-manager')

    expect(delta.context).toBe('vessels.self')
    expect(delta.updates).toHaveLength(1)

    const values = getValues(capturedDeltas)
    expect(values).toHaveLength(2)

    const alertValue = findValue(values, 'alerts.active.')
    expect(alertValue.value).toBeDefined()
    expect((alertValue.value as { priority: string }).priority).toBe('alarm')

    const indicationValue = findValue(values, 'alerts.indication')
    expect(indicationValue.value).toBeDefined()
  })

  it('should publish null for cleared alert', async () => {
    const alert = await alertManager.raiseAlert({
      path: 'electrical.battery.low',
      sourceId: 'test',
      priority: 'caution',
      message: 'Low battery'
    })
    capturedDeltas = []

    // Caution auto-clears on clearCondition
    await alertManager.clearCondition(alert.id)

    expect(capturedDeltas).toHaveLength(1)
    const alertValue = findValue(getValues(capturedDeltas), 'alerts.active.')
    expect(alertValue.value).toBeNull()
  })

  it('should publish updated state on acknowledge', async () => {
    const alert = await alertManager.raiseAlert({
      path: 'engine.overheating.ack',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Engine overheating'
    })
    capturedDeltas = []

    await alertManager.acknowledgeAlert(alert.id, 'operator')

    expect(capturedDeltas).toHaveLength(1)
    const alertValue = findValue(getValues(capturedDeltas), 'alerts.active.')
    expect((alertValue.value as { state: string }).state).toBe('acknowledged')
  })

  it('should publish updated state on silence', async () => {
    const alert = await alertManager.raiseAlert({
      path: 'engine.overheating.silence',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Engine overheating'
    })
    capturedDeltas = []

    await alertManager.silenceAlert(alert.id)

    expect(capturedDeltas).toHaveLength(1)
    const alertValue = findValue(getValues(capturedDeltas), 'alerts.active.')
    expect((alertValue.value as { silenced: boolean }).silenced).toBe(true)
  })

  it('should publish updated priority on escalation', async () => {
    await alertManager.raiseAlert({
      path: 'engine.temperature.rising',
      sourceId: 'test',
      priority: 'warning',
      message: 'Engine temperature rising'
    })
    capturedDeltas = []

    // Trigger escalation via fake timers
    fakeTimers.advanceTime(300_000)

    expect(capturedDeltas).toHaveLength(1)
    const alertValue = findValue(getValues(capturedDeltas), 'alerts.active.')
    expect((alertValue.value as { priority: string }).priority).toBe('alarm')
  })

  it('should set delta context to vessels.self', async () => {
    await alertManager.raiseAlert({
      path: 'test.context',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    expect(capturedDeltas[0].delta.context).toBe('vessels.self')
  })

  it('should set source label to alert-manager', async () => {
    await alertManager.raiseAlert({
      path: 'test.source',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    const update = capturedDeltas[0].delta.updates[0]
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- DeltaPublisher uses legacy source property
    expect(update.source).toEqual({ label: 'alert-manager' })
  })

  it('should stop publishing after stop()', async () => {
    publisher.stop()

    await alertManager.raiseAlert({
      path: 'test.stopped',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    expect(capturedDeltas).toHaveLength(0)
  })

  it('should not duplicate listeners on double start()', async () => {
    // Call start() again without stop()
    publisher.start()

    await alertManager.raiseAlert({
      path: 'test.dedup',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    // Should still only get one delta, not two
    expect(capturedDeltas).toHaveLength(1)
  })

  it('should not propagate handleMessage errors', async () => {
    publisher.stop()

    const debugMessages: unknown[] = []
    const brokenPublisher = new DeltaPublisher({
      alertManager,
      handleMessage: () => {
        throw new Error('Transport failure')
      },
      pluginId: 'signalk-alert-manager',
      debug: (msg: unknown, ...args: unknown[]) => {
        debugMessages.push({ msg, args })
      }
    })
    brokenPublisher.start()

    // Should not throw despite broken handleMessage
    await alertManager.raiseAlert({
      path: 'test.broken1',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    expect(debugMessages.length).toBeGreaterThan(0)

    // Subsequent events should still work (listener not killed)
    await alertManager.raiseAlert({
      path: 'test.broken2',
      sourceId: 'test2',
      priority: 'warning',
      message: 'Test 2'
    })

    expect(debugMessages.length).toBeGreaterThan(1)
    brokenPublisher.stop()
  })

  it('should include indication state on every event', async () => {
    await alertManager.raiseAlert({
      path: 'test.indication',
      sourceId: 'test',
      priority: 'alarm',
      message: 'Test'
    })

    const indicationValue = findValue(getValues(capturedDeltas), 'alerts.indication')
    const indication = indicationValue.value as {
      audible: boolean
      priority: string | null
      unacknowledgedCount: number
    }
    expect(indication.audible).toBe(true)
    expect(indication.priority).toBe('alarm')
    expect(indication.unacknowledgedCount).toBe(1)
  })
})
