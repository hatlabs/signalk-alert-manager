/**
 * OpenAPI Specification Tests
 *
 * Validates the OpenAPI spec structure, endpoint coverage, and schema
 * completeness. Also verifies the getOpenApi() plugin method.
 */

import { describe, it, expect } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import openApi from '../../src/api/openApi.json' with { type: 'json' }
import createPlugin from '../../src/index.js'
import { MockServerAPI } from '../../src/test/MockServerAPI.js'

describe('OpenAPI specification', () => {
  // ===========================================================================
  // Structure validation
  // ===========================================================================

  it('should have required top-level fields', () => {
    expect(openApi.openapi).toMatch(/^3\.0\.\d+$/)
    expect(openApi.info).toBeDefined()
    expect(openApi.info.title).toBeDefined()
    expect(openApi.info.version).toBeDefined()
    expect(openApi.paths).toBeDefined()
  })

  it('should have a servers entry with the Signal K plugin base path', () => {
    expect(openApi.servers).toBeDefined()
    expect(openApi.servers.length).toBeGreaterThan(0)
    expect(openApi.servers[0].url).toBe('/plugins/signalk-alert-manager')
  })

  // ===========================================================================
  // Endpoint coverage
  // ===========================================================================

  const expectedEndpoints: [string, string][] = [
    ['get', '/alerts'],
    ['post', '/alerts'],
    ['get', '/alerts/history'],
    ['post', '/alerts/silence-all'],
    ['get', '/alerts/{id}'],
    ['post', '/alerts/{id}/acknowledge'],
    ['post', '/alerts/{id}/escalate'],
    ['post', '/alerts/{id}/silence'],
    ['put', '/alerts/{id}/condition']
  ]

  it('should document all 9 endpoints', () => {
    const paths = openApi.paths as Record<string, Record<string, unknown>>
    const documented: [string, string][] = []

    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        documented.push([method, path])
      }
    }

    for (const [method, path] of expectedEndpoints) {
      expect(
        documented.some(([m, p]) => m === method && p === path),
        `Missing endpoint: ${method.toUpperCase()} ${path}`
      ).toBe(true)
    }

    expect(documented).toHaveLength(expectedEndpoints.length)
  })

  // ===========================================================================
  // Schema validation
  // ===========================================================================

  describe('Alert schema', () => {
    const alertSchema = openApi.components.schemas.Alert

    it('should have all required fields from the Alert interface', () => {
      const requiredFields = [
        'id',
        'path',
        '$source',
        'priority',
        'state',
        'condition',
        'latching',
        'silenced',
        'message',
        'raisedAt',
        'stateChangedAt',
        'sourceOnline',
        'lastSourceUpdate',
        'stale'
      ]
      expect(alertSchema.required).toEqual(expect.arrayContaining(requiredFields))
      expect(alertSchema.required).toHaveLength(requiredFields.length)
    })

    it('should define all properties from the Alert interface', () => {
      const expectedProperties = [
        'id',
        'path',
        '$source',
        'source',
        'priority',
        'state',
        'condition',
        'latching',
        'silenced',
        'silencedUntil',
        'message',
        'group',
        'data',
        'raisedAt',
        'stateChangedAt',
        'acknowledgedAt',
        'acknowledgedBy',
        'clearedAt',
        'sourceOnline',
        'lastSourceUpdate',
        'stale',
        'context'
      ]
      const actualProperties = Object.keys(alertSchema.properties)
      expect(actualProperties).toEqual(expect.arrayContaining(expectedProperties))
      expect(actualProperties).toHaveLength(expectedProperties.length)
    })
  })

  describe('enum schemas', () => {
    it('should define AlertPriority with all values', () => {
      const schema = openApi.components.schemas.AlertPriority
      expect(schema.enum).toEqual(['emergency', 'alarm', 'warning', 'caution'])
    })

    it('should define AlertState with all values', () => {
      const schema = openApi.components.schemas.AlertState
      expect(schema.enum).toEqual([
        'normal',
        'unacknowledged',
        'acknowledged',
        'rtn-unacknowledged'
      ])
    })

    it('should define HistoryEventType with all values', () => {
      const schema = openApi.components.schemas.HistoryEventType
      expect(schema.enum).toEqual([
        'raise',
        'acknowledge',
        'silence',
        'unsilence',
        'clear',
        'escalate'
      ])
    })
  })

  describe('RaiseAlertRequest schema', () => {
    it('should require priority and message', () => {
      const schema = openApi.components.schemas.RaiseAlertRequest
      expect(schema.required).toEqual(['path', 'priority', 'message'])
    })

    it('should define optional fields', () => {
      const schema = openApi.components.schemas.RaiseAlertRequest
      const props = Object.keys(schema.properties)
      expect(props).toEqual(expect.arrayContaining(['$source', 'group', 'data', 'latching']))
    })
  })

  describe('AlertTransitionResult schema', () => {
    it('should require alert, cleared, and previousState', () => {
      const schema = openApi.components.schemas.AlertTransitionResult
      expect(schema.required).toEqual(['alert', 'cleared', 'previousState'])
    })
  })

  describe('HistoryEntry schema', () => {
    it('should require id, alertId, eventType, and timestamp', () => {
      const schema = openApi.components.schemas.HistoryEntry
      expect(schema.required).toEqual(['id', 'alertId', 'eventType', 'timestamp'])
    })

    it('should define all optional fields', () => {
      const schema = openApi.components.schemas.HistoryEntry
      const props = Object.keys(schema.properties)
      expect(props).toEqual(
        expect.arrayContaining([
          'userId',
          'previousState',
          'newState',
          'previousPriority',
          'newPriority',
          'details'
        ])
      )
    })
  })

  // ===========================================================================
  // Error responses
  // ===========================================================================

  describe('security', () => {
    it('should define security schemes', () => {
      const schemes = openApi.components.securitySchemes
      expect(schemes.bearerAuth).toBeDefined()
      expect(schemes.cookieAuth).toBeDefined()
    })

    it('should have top-level security requirement', () => {
      expect(openApi.security).toBeDefined()
      expect(openApi.security.length).toBeGreaterThan(0)
    })

    it('should document 401 on state-mutating endpoints', () => {
      const paths = openApi.paths as Record<string, Record<string, unknown>>
      const mutatingEndpoints: [string, string][] = [
        ['post', '/alerts'],
        ['post', '/alerts/silence-all'],
        ['post', '/alerts/{id}/acknowledge'],
        ['post', '/alerts/{id}/silence'],
        ['put', '/alerts/{id}/condition']
      ]

      for (const [method, path] of mutatingEndpoints) {
        const endpoint = paths[path][method] as { responses: Record<string, unknown> }
        expect(
          endpoint.responses['401'],
          `Missing 401 on ${method.toUpperCase()} ${path}`
        ).toBeDefined()
      }
    })
  })

  describe('error responses', () => {
    it('should define standard error responses', () => {
      const responses = openApi.components.responses
      expect(responses.BadRequest).toBeDefined()
      expect(responses.NotFound).toBeDefined()
      expect(responses.Unauthorized).toBeDefined()
      expect(responses.InternalError).toBeDefined()
      expect(responses.ServiceUnavailable).toBeDefined()
    })
  })

  // ===========================================================================
  // Plugin getOpenApi()
  // ===========================================================================

  describe('getOpenApi()', () => {
    it('should return the OpenAPI spec from the plugin', () => {
      const mockApp = new MockServerAPI()
      const plugin = createPlugin(mockApp as unknown as ServerAPI)

      expect(typeof plugin.getOpenApi).toBe('function')
      expect(plugin.getOpenApi?.()).toBe(openApi)
    })
  })
})
