/**
 * signalk-alert-manager - Signal K server plugin for centralized alert management
 *
 * Implements IEC 62682 alert state machine and IMO alert priority levels.
 */

import { join } from 'path'
import type { IRouter } from 'express'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { PluginConfig } from './types.js'
import { AlertManager, type AlertManagerConfig } from './core/AlertManager.js'
import { AlertStore } from './store/AlertStore.js'
import { HistoryStore } from './store/HistoryStore.js'
import { NotificationTransformer } from './integration/NotificationTransformer.js'
import { AlertDeltaTransformer } from './integration/AlertDeltaTransformer.js'
import { DeltaPublisher } from './integration/DeltaPublisher.js'
import { registerRoutes } from './api/routes.js'
import openApi from './api/openApi.json' with { type: 'json' }

// Export all types for use by other plugins and clients
export type {
  AlertPriority,
  AlertState,
  Alert,
  AlertDefinition,
  AlertTransitionResult,
  RaiseAlertRequest,
  AlertFilter,
  HistoryQuery,
  HistoryEventType,
  HistoryEntry,
  IAlertStore,
  PluginConfig
} from './types.js'

/**
 * Configuration schema for the plugin.
 * Follows JSON Schema format for Signal K Admin UI.
 */
const configSchema = {
  type: 'object' as const,
  properties: {
    audio: {
      type: 'object',
      title: 'Audio Settings',
      properties: {
        minAudiblePriority: {
          type: 'string',
          title: 'Minimum Audible Priority',
          description:
            'Lowest priority level that triggers browser audio alerts. Alerts below this priority are silent.',
          default: 'warning',
          enum: ['off', 'emergency', 'alarm', 'warning']
        }
      }
    },
    silencing: {
      type: 'object',
      title: 'Silencing Settings',
      properties: {
        defaultMaxSilenceSeconds: {
          type: 'number',
          title: 'Default Silence Duration (seconds)',
          description: 'Maximum time a non-emergency alert can be silenced',
          default: 120
        },
        emergencyMaxSilenceSeconds: {
          type: 'number',
          title: 'Emergency Silence Duration (seconds)',
          description: 'Maximum time an emergency can be silenced',
          default: 30
        }
      }
    },
    escalation: {
      type: 'object',
      title: 'Escalation Settings',
      properties: {
        warningToAlarm: {
          type: 'object',
          title: 'Warning to Alarm Escalation',
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Enable Escalation',
              description: 'Automatically escalate unacknowledged warnings to alarms',
              default: true
            },
            timeoutSeconds: {
              type: 'number',
              title: 'Timeout (seconds)',
              description: 'Time before warning escalates to alarm',
              default: 300
            }
          }
        }
      }
    },
    sourceTimeout: {
      type: 'object',
      title: 'Source Timeout Settings',
      properties: {
        markStaleAfterSeconds: {
          type: 'number',
          title: 'Stale Timeout (seconds)',
          description: 'Mark alert as stale if source stops updating',
          default: 60
        }
      }
    },
    history: {
      type: 'object',
      title: 'History Settings',
      properties: {
        retentionDays: {
          type: 'number',
          title: 'Retention Period (days)',
          description: 'How long to keep alert history',
          default: 90
        }
      }
    },
    dev: {
      type: 'object',
      title: 'Developer Settings',
      properties: {
        enableSimulation: {
          type: 'boolean',
          title: 'Enable Simulation',
          description: 'Show the alert simulation button in the UI toolbar',
          default: false
        }
      }
    }
  }
}

/** UI config exposed to the browser via GET /config/ui. */
interface UiConfig {
  minAudiblePriority: 'off' | 'emergency' | 'alarm' | 'warning'
  enableSimulation: boolean
}

/** Resolve PluginConfig to AlertManagerConfig with defaults. */
function resolveConfig(pluginConfig: PluginConfig): AlertManagerConfig {
  return {
    escalation: {
      enabled: pluginConfig.escalation?.warningToAlarm?.enabled ?? true,
      timeoutSeconds: pluginConfig.escalation?.warningToAlarm?.timeoutSeconds ?? 300
    },
    silencing: {
      defaultMaxSilenceSeconds: pluginConfig.silencing?.defaultMaxSilenceSeconds ?? 120,
      emergencyMaxSilenceSeconds: pluginConfig.silencing?.emergencyMaxSilenceSeconds ?? 30
    },
    sourceTimeout: {
      markStaleAfterSeconds: pluginConfig.sourceTimeout?.markStaleAfterSeconds ?? 60
    },
    retentionDays: pluginConfig.history?.retentionDays ?? 90
  }
}

/** Resolve UI-only config from plugin config. */
function resolveUiConfig(pluginConfig: PluginConfig): UiConfig {
  return {
    minAudiblePriority: pluginConfig.audio?.minAudiblePriority ?? 'warning',
    enableSimulation: pluginConfig.dev?.enableSimulation ?? false
  }
}

/**
 * Extended plugin interface with internal state access for testing.
 */
export interface AlertManagerPlugin extends Plugin {
  /** Get the stored restart callback (for testing) */
  getRestartCallback?: () => ((newConfiguration: object) => void) | undefined
  /** Promise that resolves when async initialization completes */
  whenReady?: () => Promise<void>
  /** Return the OpenAPI spec for Signal K server discovery */
  getOpenApi?: () => object
}

export default function createPlugin(app: ServerAPI): AlertManagerPlugin {
  // Plugin state
  let started = false
  let restartCallback: ((newConfiguration: object) => void) | undefined
  let manager: AlertManager | undefined
  let transformer: NotificationTransformer | undefined
  let alertDeltaTransformer: AlertDeltaTransformer | undefined
  let publisher: DeltaPublisher | undefined
  let alertStore: AlertStore | undefined
  let historyStore: HistoryStore | undefined
  let readyPromise: Promise<void> | undefined
  let uiConfig: UiConfig = { minAudiblePriority: 'warning', enableSimulation: false }

  const plugin: AlertManagerPlugin = {
    id: 'signalk-alert-manager',
    name: 'Signal K Alert Manager',
    description: 'Centralized alert management following IEC 62682 and IMO standards',

    schema: configSchema,

    start(config: object, restart: (newConfiguration: object) => void): void {
      if (started) {
        return
      }

      const pluginConfig = config as PluginConfig
      started = true
      restartCallback = restart

      app.debug('Starting alert manager with config:', pluginConfig)
      app.setPluginStatus('Initializing')

      uiConfig = resolveUiConfig(pluginConfig)
      const managerConfig = resolveConfig(pluginConfig)
      const dbPath = join(app.getDataDirPath(), 'alerts.db')

      alertStore = new AlertStore(dbPath)
      historyStore = new HistoryStore(dbPath)

      readyPromise = (async () => {
        await alertStore.initialize()
        await historyStore.initialize()

        // stop() may set started=false between awaits; TS can't track this
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!started) {
          return
        }

        const mgr = new AlertManager(managerConfig, undefined, alertStore, historyStore)
        manager = mgr
        await mgr.loadFromStore()

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!started) {
          mgr.stop()
          return
        }

        const xformer = new NotificationTransformer({
          alertManager: mgr,
          registerDeltaInputHandler: (handler) => {
            app.registerDeltaInputHandler(handler)
          },
          debug: (msg, ...args) => {
            app.debug(msg, ...args)
          }
        })
        xformer.start()
        transformer = xformer

        const alertXformer = new AlertDeltaTransformer({
          alertManager: mgr,
          registerDeltaInputHandler: (handler) => {
            app.registerDeltaInputHandler(handler)
          },
          debug: (msg, ...args) => {
            app.debug(msg, ...args)
          }
        })
        alertXformer.start()
        alertDeltaTransformer = alertXformer

        const pub = new DeltaPublisher({
          alertManager: mgr,
          handleMessage: (id, delta) => {
            app.handleMessage(id, delta)
          },
          pluginId: plugin.id,
          debug: (msg, ...args) => {
            app.debug(msg, ...args)
          }
        })
        pub.start()
        publisher = pub

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!started) {
          xformer.stop()
          alertXformer.stop()
          pub.stop()
          mgr.stop()
          return
        }

        app.setPluginStatus('Running')
      })()

      readyPromise.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        app.error(`Alert manager initialization failed: ${message}`)
        app.setPluginError(`Initialization failed: ${message}`)
      })
    },

    stop(): void {
      if (!started) {
        return
      }

      app.debug('Stopping alert manager')
      started = false
      restartCallback = undefined

      transformer?.stop()
      alertDeltaTransformer?.stop()
      publisher?.stop()
      manager?.stop()

      alertStore?.close().catch(() => undefined)
      historyStore?.close().catch(() => undefined)
      alertStore = undefined
      historyStore = undefined
      manager = undefined
      transformer = undefined
      alertDeltaTransformer = undefined
      publisher = undefined
      readyPromise = undefined
    },

    registerWithRouter(router: IRouter): void {
      registerRoutes(router, {
        getAlertManager: () => manager,
        getHistoryStore: () => historyStore,
        getUiConfig: () => uiConfig
      })
    },

    getRestartCallback: () => restartCallback,
    whenReady: () => readyPromise ?? Promise.resolve(),
    getOpenApi: () => openApi
  }

  return plugin
}
