/**
 * signalk-alert-manager - Signal K server plugin for centralized alert management
 *
 * Implements IEC 62682 alert state machine and IMO alert priority levels.
 */

import type { Plugin, ServerAPI } from '@signalk/server-api'

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
  IAlertStore
} from './types.js'

/**
 * Signal K plugin factory function.
 * Called by the server to instantiate the plugin.
 */
export default function createPlugin(_app: ServerAPI): Plugin {
  // TODO: Implement plugin - this is a placeholder that will fail tests
  return {} as Plugin
}
