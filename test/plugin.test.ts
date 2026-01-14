import { describe, it, expect, beforeEach } from 'vitest'
import { MockServerAPI } from '../src/test/MockServerAPI.js'
import type { ServerAPI } from '@signalk/server-api'

// Import the plugin factory function and extended interface
import pluginFactory, { type AlertManagerPlugin } from '../src/index.js'

// Schema type for type-safe property access
interface PluginSchema {
  type: string
  properties: Record<string, unknown>
}

describe('Signal K Plugin', () => {
  let mockApi: MockServerAPI
  let plugin: AlertManagerPlugin

  beforeEach(() => {
    mockApi = new MockServerAPI()
    // Cast MockServerAPI to ServerAPI for plugin initialization
    plugin = pluginFactory(mockApi as unknown as ServerAPI)
  })

  describe('Plugin Interface', () => {
    it('should export a function', () => {
      expect(typeof pluginFactory).toBe('function')
    })

    it('should return an object with required properties', () => {
      expect(plugin).toBeDefined()
      expect(typeof plugin.id).toBe('string')
      expect(typeof plugin.name).toBe('string')
      expect(typeof plugin.start).toBe('function')
      expect(typeof plugin.stop).toBe('function')
    })

    it('should have correct plugin id', () => {
      expect(plugin.id).toBe('signalk-alert-manager')
    })

    it('should have a human-readable name', () => {
      expect(plugin.name).toBe('Signal K Alert Manager')
    })

    it('should have a description', () => {
      expect(plugin.description).toBeDefined()
      expect(typeof plugin.description).toBe('string')
    })
  })

  describe('Configuration Schema', () => {
    it('should provide a schema property', () => {
      expect(plugin.schema).toBeDefined()
    })

    it('should have schema as object or function', () => {
      const schemaType = typeof plugin.schema
      expect(schemaType === 'object' || schemaType === 'function').toBe(true)
    })

    it('should return valid JSON Schema structure', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema).toHaveProperty('type', 'object')
      expect(schema).toHaveProperty('properties')
    })

    it('should include escalation configuration', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema.properties).toHaveProperty('escalation')
    })

    it('should include silencing configuration', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema.properties).toHaveProperty('silencing')
    })

    it('should include history configuration', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema.properties).toHaveProperty('history')
    })

    it('should include sourceTimeout configuration', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema.properties).toHaveProperty('sourceTimeout')
    })

    it('should include UI configuration', () => {
      const schema = (
        typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      ) as PluginSchema
      expect(schema.properties).toHaveProperty('ui')
    })
  })

  describe('Plugin Lifecycle', () => {
    it('should start without errors with empty config', () => {
      expect(() => {
        plugin.start({}, () => {
          /* restart callback */
        })
      }).not.toThrow()
    })

    it('should set plugin status on start', () => {
      plugin.start({}, () => {
        /* restart callback */
      })

      const status = mockApi.getPluginStatus()
      expect(status).toBeDefined()
      expect(typeof status).toBe('string')
    })

    it('should stop without errors', () => {
      plugin.start({}, () => {
        /* restart callback */
      })

      expect(() => {
        void plugin.stop()
      }).not.toThrow()
    })

    it('should handle stop returning void or Promise', async () => {
      plugin.start({}, () => {
        /* restart callback */
      })

      const result = plugin.stop()
      // stop() can return void or Promise<void>
      if (result !== undefined) {
        expect(result).toBeInstanceOf(Promise)
        await result
      }
    })

    it('should be safe to call stop multiple times', () => {
      plugin.start({}, () => {
        /* restart callback */
      })

      expect(() => {
        void plugin.stop()
        void plugin.stop()
      }).not.toThrow()
    })

    it('should be safe to call stop without start', () => {
      expect(() => {
        void plugin.stop()
      }).not.toThrow()
    })
  })

  describe('Configuration Handling', () => {
    it('should accept configuration with defaults', () => {
      const config = {
        escalation: {
          warningToAlarm: {
            enabled: true,
            timeoutSeconds: 300
          }
        }
      }

      expect(() => {
        plugin.start(config, () => {
          /* restart callback */
        })
      }).not.toThrow()
    })

    it('should accept partial configuration', () => {
      const config = {
        silencing: {
          alarmMaxSeconds: 60
        }
      }

      expect(() => {
        plugin.start(config, () => {
          /* restart callback */
        })
      }).not.toThrow()
    })

    it('should store restart callback for later use', () => {
      const restartFn = (): void => {
        /* restart callback */
      }

      plugin.start({}, restartFn)

      // Verify the restart callback is stored
      expect(plugin.getRestartCallback).toBeDefined()
      expect(plugin.getRestartCallback?.()).toBe(restartFn)
    })

    it('should clear restart callback on stop', () => {
      plugin.start({}, () => {
        /* restart callback */
      })
      void plugin.stop()

      expect(plugin.getRestartCallback?.()).toBeUndefined()
    })
  })
})
