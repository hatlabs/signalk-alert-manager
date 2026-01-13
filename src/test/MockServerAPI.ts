/**
 * Mock ServerAPI for unit testing Signal K plugin components.
 *
 * Provides a test harness that simulates the Signal K server environment
 * without requiring a real server connection.
 */

import { Bus } from 'baconjs'
import type {
  Delta,
  DeltaInputHandler,
  Context,
  Path,
  Timestamp,
  Update,
  PathValue
} from '@signalk/server-api'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Captured delta with metadata.
 */
export interface CapturedDelta {
  pluginId: string
  delta: Delta
  timestamp: Date
}

/**
 * Captured log entries.
 */
export interface CapturedLogs {
  debug: { message: unknown; args: unknown[] }[]
  error: string[]
}

/**
 * Stream value pushed to the mock.
 */
export interface StreamValue {
  path: string
  value: unknown
  context: string
  timestamp: string
  source?: unknown
  $source?: string
}

/**
 * Input for creating a test delta with simplified string types.
 */
export interface TestDeltaInput {
  context?: string
  updates: {
    timestamp?: string
    source?: unknown
    $source?: string
    values?: { path: string; value: unknown }[]
    meta?: { path: string; value: unknown }[]
  }[]
}

/**
 * Creates a properly-typed Delta from simplified string inputs.
 * Handles the branded type conversions needed for Signal K types.
 */
export function createTestDelta(input: TestDeltaInput): Delta {
  return {
    context: input.context as Context | undefined,
    updates: input.updates.map((update) => {
      const result: Update = {} as Update

      if (update.timestamp) {
        ;(result as { timestamp: Timestamp }).timestamp = update.timestamp as Timestamp
      }
      if (update.source) {
        ;(result as { source: unknown }).source = update.source
      }
      if (update.$source) {
        ;(result as { $source: string }).$source = update.$source
      }

      if (update.values) {
        ;(result as { values: PathValue[] }).values = update.values.map((v) => ({
          path: v.path as Path,
          value: v.value as PathValue['value']
        }))
      }

      if (update.meta) {
        ;(result as { meta: { path: Path; value: unknown }[] }).meta = update.meta.map((m) => ({
          path: m.path as Path,
          value: m.value
        }))
      }

      return result
    })
  }
}

/**
 * Mock implementation of the Signal K ServerAPI for testing.
 *
 * Provides all the methods used by the alert-manager plugin, allowing
 * tests to run without a real Signal K server.
 */
export class MockServerAPI {
  // Self identity
  private _selfType: string = 'vessels'
  private _selfId: string = 'urn:mrn:signalk:uuid:test-vessel'

  // Captured state
  private capturedDeltas: CapturedDelta[] = []
  private debugLogs: { message: unknown; args: unknown[] }[] = []
  private errorLogs: string[] = []
  private pluginStatus: string | undefined
  private pluginError: string | undefined
  private pathValues = new Map<string, unknown>()
  private storedOptions: object = {}

  // Delta handling
  private deltaInputHandlers: DeltaInputHandler[] = []

  // Stream buses for streambundle
  private streamBuses = new Map<string, Bus<unknown>>()

  // =========================================================================
  // Self Identity (SelfIdentity interface)
  // =========================================================================

  get selfType(): string {
    return this._selfType
  }

  get selfId(): string {
    return this._selfId
  }

  get selfContext(): string {
    return `${this._selfType}.${this._selfId}`
  }

  /**
   * Configure the mock's self identity.
   */
  setSelfIdentity(type: string, id: string): void {
    this._selfType = type
    this._selfId = id
  }

  // =========================================================================
  // Delta Handling
  // =========================================================================

  /**
   * Emit a delta message (captures it for later verification).
   */
  handleMessage(pluginId: string, delta: Partial<Delta>): void {
    this.capturedDeltas.push({
      pluginId,
      delta: delta as Delta,
      timestamp: new Date()
    })
  }

  /**
   * Register a delta input handler (for intercepting incoming deltas).
   */
  registerDeltaInputHandler(handler: DeltaInputHandler): void {
    this.deltaInputHandlers.push(handler)
  }

  // =========================================================================
  // Path Data Access
  // =========================================================================

  /**
   * Get data from vessels.self context.
   */
  getSelfPath(path: string): unknown {
    return this.pathValues.get(path)
  }

  /**
   * Get data from any path.
   */
  getPath(path: string): unknown {
    return this.pathValues.get(path)
  }

  // =========================================================================
  // Logging
  // =========================================================================

  /**
   * Log debug message.
   */
  debug(message: unknown, ...args: unknown[]): void {
    this.debugLogs.push({ message, args })
  }

  /**
   * Log error message.
   */
  error(message: string): void {
    this.errorLogs.push(message)
  }

  // =========================================================================
  // Status
  // =========================================================================

  /**
   * Set plugin status message.
   */
  setPluginStatus(msg: string): void {
    this.pluginStatus = msg
  }

  /**
   * Set plugin error message.
   */
  setPluginError(msg: string): void {
    this.pluginError = msg
  }

  // =========================================================================
  // Storage
  // =========================================================================

  /**
   * Get the data directory path for plugin storage.
   */
  getDataDirPath(): string {
    return join(tmpdir(), 'signalk-alert-manager-test')
  }

  /**
   * Save plugin options.
   */
  savePluginOptions(options: object, callback: (err: NodeJS.ErrnoException | null) => void): void {
    this.storedOptions = { ...options }
    // Simulate async callback
    setImmediate(() => {
      callback(null)
    })
  }

  /**
   * Read plugin options.
   */
  readPluginOptions(): object {
    return { ...this.storedOptions }
  }

  // =========================================================================
  // StreamBundle
  // =========================================================================

  /**
   * Mock streambundle implementation.
   */
  readonly streambundle = {
    getSelfBus: (path: string | Path): Bus<unknown> => {
      const pathStr = String(path)
      let bus = this.streamBuses.get(pathStr)
      if (!bus) {
        bus = new Bus()
        this.streamBuses.set(pathStr, bus)
      }
      return bus
    },

    getSelfStream: (path: string | Path): Bus<unknown> => {
      return this.streambundle.getSelfBus(path)
    },

    getBus: (path?: string | Path): Bus<unknown> => {
      const pathStr = path ? String(path) : '__all__'
      let bus = this.streamBuses.get(pathStr)
      if (!bus) {
        bus = new Bus()
        this.streamBuses.set(pathStr, bus)
      }
      return bus
    },

    getAvailablePaths: (): Path[] => {
      return Array.from(this.pathValues.keys()) as Path[]
    }
  }

  // =========================================================================
  // Test Utilities (not part of ServerAPI)
  // =========================================================================

  /**
   * Push a delta to registered delta input handlers.
   * Use this to simulate incoming deltas in tests.
   */
  pushDelta(delta: Delta): void {
    if (this.deltaInputHandlers.length === 0) {
      return
    }

    // Chain handlers
    let index = 0
    const next = (d: Delta): void => {
      if (index < this.deltaInputHandlers.length) {
        const handler = this.deltaInputHandlers[index++]
        handler(d, next)
      }
    }
    next(delta)
  }

  /**
   * Push a value to a stream bus.
   * Use this to simulate incoming stream data.
   */
  pushStreamValue(path: string, value: StreamValue): void {
    const bus = this.streamBuses.get(path)
    if (bus) {
      bus.push(value)
    }
  }

  /**
   * Set a path value for getSelfPath/getPath.
   */
  setPathValue(path: string, value: unknown): void {
    this.pathValues.set(path, value)
  }

  /**
   * Get all captured deltas sent via handleMessage.
   */
  getCapturedDeltas(): CapturedDelta[] {
    return [...this.capturedDeltas]
  }

  /**
   * Get all captured log messages.
   */
  getCapturedLogs(): CapturedLogs {
    return {
      debug: [...this.debugLogs],
      error: [...this.errorLogs]
    }
  }

  /**
   * Get the current plugin status.
   */
  getPluginStatus(): string | undefined {
    return this.pluginStatus
  }

  /**
   * Get the current plugin error.
   */
  getPluginError(): string | undefined {
    return this.pluginError
  }

  /**
   * Reset all captured state.
   * Does NOT clear registered handlers.
   */
  reset(): void {
    this.capturedDeltas = []
    this.debugLogs = []
    this.errorLogs = []
    this.pluginStatus = undefined
    this.pluginError = undefined
    this.pathValues.clear()
    this.storedOptions = {}
    // Clear stream buses but keep the map structure
    for (const bus of this.streamBuses.values()) {
      bus.end()
    }
    this.streamBuses.clear()
  }

  /**
   * Clear all registered delta handlers.
   */
  clearDeltaHandlers(): void {
    this.deltaInputHandlers = []
  }
}
