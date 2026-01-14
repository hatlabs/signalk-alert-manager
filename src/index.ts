/**
 * signalk-alert-manager - Signal K server plugin for centralized alert management
 *
 * Implements IEC 62682 alert state machine and IMO alert priority levels.
 */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { PluginConfig } from './types.js'

// Export all types for use by other plugins and clients
export type {
  AlertPriority,
  AlertState,
  Alert,
  AlertDefinition,
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

/**
 * Signal K plugin factory function.
 * Called by the server to instantiate the plugin.
 */
/**
 * Extended plugin interface with internal state access for testing.
 */
export interface AlertManagerPlugin extends Plugin {
  /** Get the stored restart callback (for testing) */
  getRestartCallback?: () => ((newConfiguration: object) => void) | undefined
}

export default function createPlugin(app: ServerAPI): AlertManagerPlugin {
  // Plugin state
  let started = false
  let restartCallback: ((newConfiguration: object) => void) | undefined

  const plugin: AlertManagerPlugin = {
    id: 'signalk-alert-manager',
    name: 'Signal K Alert Manager',
    description: 'Centralized alert management following IEC 62682 and IMO standards',

    schema: configSchema,

    start(config: object, restart: (newConfiguration: object) => void): void {
      const pluginConfig = config as PluginConfig
      started = true
      restartCallback = restart

      app.debug('Starting alert manager with config:', pluginConfig)
      app.setPluginStatus('Initialized')
    },

    stop(): void {
      if (!started) {
        return
      }

      app.debug('Stopping alert manager')
      started = false
      restartCallback = undefined
    },

    // Test utility to verify restart callback is stored
    getRestartCallback: () => restartCallback
  }

  return plugin
}
