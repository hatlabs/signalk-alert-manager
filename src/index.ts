/**
 * signalk-alert-manager - Signal K server plugin for centralized alert management
 *
 * Implements IEC 62682 alert state machine and IMO alert priority levels.
 */

import { join } from 'path'
import type { IRouter } from 'express'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { AlertDefinition, AlertManagerAPI, PluginConfig } from './types.js'
import { AlertManager, type AlertManagerConfig } from './core/AlertManager.js'
import { AlertStore } from './store/AlertStore.js'
import { HistoryStore } from './store/HistoryStore.js'
import { NotificationTransformer } from './integration/NotificationTransformer.js'
import { DeltaPublisher } from './integration/DeltaPublisher.js'
import { registerRoutes } from './api/routes.js'
import openApi from './api/openApi.json' with { type: 'json' }

// Export all types for use by other plugins and clients
export type {
  AlertPriority,
  AlertState,
  Alert,
  AlertDefinition,
  AlertManagerAPI,
  AlertTransitionResult,
  IndicationState,
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
    silencing: {
      type: 'object',
      title: 'Silencing Settings',
      properties: {
        alarmMaxSeconds: {
          type: 'number',
          title: 'Alarm Silence Duration (seconds)',
          description: 'Maximum time an alarm can be silenced',
          default: 30
        },
        emergencyMaxSeconds: {
          type: 'number',
          title: 'Emergency Silence Duration (seconds)',
          description: 'Maximum time an emergency can be silenced',
          default: 10
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
    ui: {
      type: 'object',
      title: 'UI Settings',
      properties: {
        audioEnabled: {
          type: 'boolean',
          title: 'Enable Audio Alerts',
          description: 'Play audio for unacknowledged alerts',
          default: true
        },
        showBanner: {
          type: 'boolean',
          title: 'Show Alert Banner',
          description: 'Display alert banner at top of UI',
          default: true
        }
      }
    }
  }
}

/** Resolve PluginConfig to AlertManagerConfig with defaults. */
function resolveConfig(pluginConfig: PluginConfig): AlertManagerConfig {
  return {
    escalation: {
      enabled: pluginConfig.escalation?.warningToAlarm?.enabled ?? true,
      timeoutSeconds: pluginConfig.escalation?.warningToAlarm?.timeoutSeconds ?? 300
    },
    silencing: {
      alarmMaxSeconds: pluginConfig.silencing?.alarmMaxSeconds ?? 30,
      emergencyMaxSeconds: pluginConfig.silencing?.emergencyMaxSeconds ?? 10
    },
    sourceTimeout: {
      markStaleAfterSeconds: pluginConfig.sourceTimeout?.markStaleAfterSeconds ?? 60
    },
    retentionDays: pluginConfig.history?.retentionDays ?? 90
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
  let publisher: DeltaPublisher | undefined
  let alertStore: AlertStore | undefined
  let historyStore: HistoryStore | undefined
  let readyPromise: Promise<void> | undefined
  const alertTypes = new Map<string, AlertDefinition>()

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
          pub.stop()
          mgr.stop()
          return
        }

        const api: AlertManagerAPI = {
          raiseAlert: (params) => mgr.raiseAlert(params),
          clearCondition: (alertId) => mgr.clearCondition(alertId),
          acknowledgeAlert: (alertId, userId) => mgr.acknowledgeAlert(alertId, userId),
          silenceAlert: (alertId, durationMs) => mgr.silenceAlert(alertId, durationMs),
          silenceAll: () => mgr.silenceAll(),
          getAlerts: (filter) => mgr.getAlerts(filter),
          getAlert: (id) => mgr.getAlert(id),
          getIndicationState: () => mgr.getIndicationState(),
          registerAlertType: (definition) => {
            alertTypes.set(definition.alertType, definition)
          }
        }
        app.alertManager = api

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
      publisher?.stop()
      manager?.stop()
      delete app.alertManager
      alertTypes.clear()

      alertStore?.close().catch(() => undefined)
      historyStore?.close().catch(() => undefined)
      alertStore = undefined
      historyStore = undefined
      manager = undefined
      transformer = undefined
      publisher = undefined
      readyPromise = undefined
    },

    registerWithRouter(router: IRouter): void {
      registerRoutes(router, {
        getAlertManager: () => manager,
        getHistoryStore: () => historyStore
      })
    },

    getRestartCallback: () => restartCallback,
    whenReady: () => readyPromise ?? Promise.resolve(),
    getOpenApi: () => openApi
  }

  return plugin
}
