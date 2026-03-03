/**
 * DeltaPublisher
 *
 * Subscribes to AlertManager events and publishes alert state changes
 * as Signal K deltas, allowing other SK consumers to react to alerts.
 */

import type { Delta, Context, Path, Timestamp } from '@signalk/server-api'
import type { AlertManager, AlertEvent } from '../core/AlertManager.js'

export interface DeltaPublisherDeps {
  alertManager: AlertManager
  handleMessage: (pluginId: string, delta: Partial<Delta>) => void
  pluginId: string
  debug?: (msg: unknown, ...args: unknown[]) => void
}

export class DeltaPublisher {
  private deps: DeltaPublisherDeps
  private listener: ((event: AlertEvent) => void) | null = null

  constructor(deps: DeltaPublisherDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.listener) {
      return
    }
    this.listener = (event: AlertEvent) => {
      this.publishDelta(event)
    }
    this.deps.alertManager.on('alert', this.listener)
  }

  stop(): void {
    if (this.listener) {
      this.deps.alertManager.removeListener('alert', this.listener)
      this.listener = null
    }
  }

  private publishDelta(event: AlertEvent): void {
    try {
      const alert = event.alert
      const alertValue = event.type === 'cleared' ? { ...alert, state: 'normal' as const } : alert

      const delta: Delta = {
        context: 'vessels.self' as Context,
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString() as Timestamp,
            values: [
              {
                path: `alerts.${alert.path}` as Path,
                value: alertValue
              }
            ]
          }
        ]
      }

      this.deps.handleMessage(this.deps.pluginId, delta)
    } catch (err: unknown) {
      // Never let publish errors kill the event listener
      this.deps.debug?.(
        'Failed to publish delta:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
