import { describe, it, expect, beforeEach } from 'vitest'
import { MockServerAPI, createTestDelta } from '../../src/test/MockServerAPI.js'
import type { Delta, DeltaInputHandler } from '@signalk/server-api'

describe('MockServerAPI', () => {
  let mockApi: MockServerAPI

  beforeEach(() => {
    mockApi = new MockServerAPI()
  })

  describe('Delta Handling', () => {
    it('should capture deltas sent via handleMessage', () => {
      const delta = createTestDelta({
        context: 'vessels.self',
        updates: [
          {
            timestamp: '2026-01-14T10:00:00Z',
            values: [{ path: 'navigation.speedOverGround', value: 5.5 }]
          }
        ]
      })

      mockApi.handleMessage('test-plugin', delta)

      const captured = mockApi.getCapturedDeltas()
      expect(captured).toHaveLength(1)
      expect(captured[0].delta).toEqual(delta)
      expect(captured[0].pluginId).toBe('test-plugin')
    })

    it('should trigger registered delta input handlers when pushDelta is called', () => {
      const receivedDeltas: Delta[] = []

      const handler: DeltaInputHandler = (delta, next) => {
        receivedDeltas.push(delta)
        next(delta)
      }
      mockApi.registerDeltaInputHandler(handler)

      const delta = createTestDelta({
        context: 'vessels.self',
        updates: [
          {
            timestamp: '2026-01-14T10:00:00Z',
            values: [{ path: 'notifications.engine.overheating', value: { state: 'alarm' } }]
          }
        ]
      })

      mockApi.pushDelta(delta)

      expect(receivedDeltas).toHaveLength(1)
      expect(receivedDeltas[0]).toEqual(delta)
    })

    it('should chain multiple delta input handlers', () => {
      const order: number[] = []

      const handler1: DeltaInputHandler = (delta, next) => {
        order.push(1)
        next(delta)
      }

      const handler2: DeltaInputHandler = (delta, next) => {
        order.push(2)
        next(delta)
      }

      mockApi.registerDeltaInputHandler(handler1)
      mockApi.registerDeltaInputHandler(handler2)

      mockApi.pushDelta(
        createTestDelta({
          context: 'vessels.self',
          updates: [{ values: [{ path: 'test', value: 1 }] }]
        })
      )

      expect(order).toEqual([1, 2])
    })
  })

  describe('Path Data', () => {
    it('should return configured path values via getSelfPath', () => {
      mockApi.setPathValue('navigation.speedOverGround', 5.5)

      const value = mockApi.getSelfPath('navigation.speedOverGround')
      expect(value).toBe(5.5)
    })

    it('should return undefined for unconfigured paths', () => {
      const value = mockApi.getSelfPath('nonexistent.path')
      expect(value).toBeUndefined()
    })

    it('should return configured path values via getPath', () => {
      mockApi.setPathValue('vessels.other.navigation.position', {
        latitude: 60,
        longitude: 25
      })

      const value = mockApi.getPath('vessels.other.navigation.position')
      expect(value).toEqual({ latitude: 60, longitude: 25 })
    })
  })

  describe('Storage', () => {
    it('should return a data directory path', () => {
      const path = mockApi.getDataDirPath()
      expect(path).toBeDefined()
      expect(typeof path).toBe('string')
    })

    it('should save and read plugin options', () => {
      const options = { setting1: 'value1', setting2: 42 }

      return new Promise<void>((resolve) => {
        mockApi.savePluginOptions(options, (err: NodeJS.ErrnoException | null) => {
          expect(err).toBeNull()

          const loaded = mockApi.readPluginOptions()
          expect(loaded).toEqual(options)
          resolve()
        })
      })
    })

    it('should return empty object when no options saved', () => {
      const options = mockApi.readPluginOptions()
      expect(options).toEqual({})
    })
  })

  describe('Logging', () => {
    it('should capture debug messages', () => {
      mockApi.debug('Test message', 'arg1', 123)

      const logs = mockApi.getCapturedLogs()
      expect(logs.debug).toHaveLength(1)
      expect(logs.debug[0]).toEqual({ message: 'Test message', args: ['arg1', 123] })
    })

    it('should capture error messages', () => {
      mockApi.error('Something went wrong')

      const logs = mockApi.getCapturedLogs()
      expect(logs.error).toHaveLength(1)
      expect(logs.error[0]).toBe('Something went wrong')
    })
  })

  describe('Status', () => {
    it('should capture plugin status', () => {
      mockApi.setPluginStatus('Running normally')

      expect(mockApi.getPluginStatus()).toBe('Running normally')
    })

    it('should capture plugin error status', () => {
      mockApi.setPluginError('Connection failed')

      expect(mockApi.getPluginError()).toBe('Connection failed')
    })
  })

  describe('Self Identity', () => {
    it('should provide default self identity', () => {
      expect(mockApi.selfType).toBe('vessels')
      expect(mockApi.selfId).toBeDefined()
      expect(mockApi.selfContext).toMatch(/^vessels\./)
    })

    it('should allow configuring self identity', () => {
      mockApi.setSelfIdentity('vessels', 'urn:mrn:imo:mmsi:123456789')

      expect(mockApi.selfType).toBe('vessels')
      expect(mockApi.selfId).toBe('urn:mrn:imo:mmsi:123456789')
      expect(mockApi.selfContext).toBe('vessels.urn:mrn:imo:mmsi:123456789')
    })
  })

  describe('StreamBundle', () => {
    it('should provide a streambundle with getSelfBus', () => {
      expect(mockApi.streambundle).toBeDefined()
      expect(mockApi.streambundle.getSelfBus).toBeDefined()
    })

    it('should emit values pushed via pushStreamValue', () => {
      const received: unknown[] = []

      mockApi.streambundle.getSelfBus('navigation.speedOverGround').onValue((v: unknown) => {
        received.push(v)
      })

      mockApi.pushStreamValue('navigation.speedOverGround', {
        path: 'navigation.speedOverGround',
        value: 5.5,
        context: 'vessels.self',
        timestamp: '2026-01-14T10:00:00Z'
      })

      expect(received).toHaveLength(1)
    })
  })

  describe('Reset', () => {
    it('should clear all captured state', () => {
      // Populate state
      mockApi.handleMessage(
        'plugin',
        createTestDelta({ updates: [{ values: [{ path: 'test', value: 1 }] }] })
      )
      mockApi.debug('test')
      mockApi.error('test error')
      mockApi.setPluginStatus('running')
      mockApi.setPathValue('test.path', 42)

      // Reset
      mockApi.reset()

      // Verify cleared
      expect(mockApi.getCapturedDeltas()).toHaveLength(0)
      expect(mockApi.getCapturedLogs().debug).toHaveLength(0)
      expect(mockApi.getCapturedLogs().error).toHaveLength(0)
      expect(mockApi.getPluginStatus()).toBeUndefined()
      expect(mockApi.getSelfPath('test.path')).toBeUndefined()
    })

    it('should preserve registered delta handlers after reset', () => {
      const received: Delta[] = []

      const handler: DeltaInputHandler = (delta, next) => {
        received.push(delta)
        next(delta)
      }
      mockApi.registerDeltaInputHandler(handler)

      mockApi.reset()

      mockApi.pushDelta(createTestDelta({ updates: [{ values: [{ path: 'test', value: 1 }] }] }))

      expect(received).toHaveLength(1)
    })
  })

  describe('Example Usage', () => {
    it('should demonstrate typical test workflow', () => {
      // Configure mock for test
      mockApi.setPathValue('navigation.speedOverGround', 10.5)
      mockApi.setSelfIdentity('vessels', 'urn:mrn:imo:mmsi:123456789')

      // Register a delta handler (simulating what the plugin would do)
      const processedPaths: string[] = []
      const handler: DeltaInputHandler = (delta, next) => {
        delta.updates.forEach((update) => {
          if ('values' in update) {
            update.values.forEach((pv) => {
              processedPaths.push(pv.path as string)
            })
          }
        })
        next(delta)
      }
      mockApi.registerDeltaInputHandler(handler)

      // Simulate incoming notification
      mockApi.pushDelta(
        createTestDelta({
          context: 'vessels.self',
          updates: [
            {
              timestamp: new Date().toISOString(),
              values: [
                {
                  path: 'notifications.engine.overheating',
                  value: { state: 'alarm', message: 'Engine overheating' }
                }
              ]
            }
          ]
        })
      )

      // Verify the handler processed it
      expect(processedPaths).toContain('notifications.engine.overheating')

      // Simulate plugin publishing a delta
      mockApi.handleMessage(
        'test-plugin',
        createTestDelta({
          context: 'vessels.self',
          updates: [
            {
              values: [{ path: 'alerts.active.123', value: { id: '123', priority: 'alarm' } }]
            }
          ]
        })
      )

      // Verify it was captured
      const captured = mockApi.getCapturedDeltas()
      expect(captured).toHaveLength(1)
      expect(captured[0].delta.updates[0]).toHaveProperty('values')
    })
  })
})
