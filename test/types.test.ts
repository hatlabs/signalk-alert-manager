import { describe, it, expect } from 'vitest'
import type {
  AlertPriority,
  AlertState,
  Alert,
  AlertDefinition,
  IndicationState,
  RaiseAlertRequest,
  AlertFilter,
  HistoryQuery,
  HistoryEntry,
  HistoryEventType,
  IAlertStore
} from '../src/types.js'

describe('TypeScript Types', () => {
  describe('AlertPriority', () => {
    it('should accept valid priority values', () => {
      const priorities: AlertPriority[] = ['emergency', 'alarm', 'warning', 'caution']
      expect(priorities).toHaveLength(4)
    })
  })

  describe('AlertState', () => {
    it('should accept valid state values', () => {
      const states: AlertState[] = ['unacknowledged', 'acknowledged', 'rtn-unacknowledged']
      expect(states).toHaveLength(3)
    })
  })

  describe('Alert', () => {
    it('should accept a valid alert object with required fields', () => {
      const alert: Alert = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        sourceId: 'plugin-xyz',
        priority: 'alarm',
        state: 'unacknowledged',
        condition: true,
        latching: false,
        silenced: false,
        message: 'Engine coolant temperature high',
        raisedAt: '2026-01-13T10:30:00Z',
        sourceOnline: true,
        lastSourceUpdate: '2026-01-13T10:30:00Z',
        stale: false
      }
      expect(alert.id).toBeDefined()
      expect(alert.priority).toBe('alarm')
    })

    it('should accept optional fields', () => {
      const alert: Alert = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        sourceId: 'plugin-xyz',
        priority: 'warning',
        state: 'acknowledged',
        condition: true,
        latching: true,
        silenced: true,
        silencedUntil: '2026-01-13T10:31:00Z',
        message: 'Low fuel warning',
        category: 'engine',
        data: { path: 'tanks.fuel.0.currentLevel', value: 0.1 },
        raisedAt: '2026-01-13T10:00:00Z',
        acknowledgedAt: '2026-01-13T10:05:00Z',
        acknowledgedBy: 'captain',
        clearedAt: undefined,
        sourceOnline: true,
        lastSourceUpdate: '2026-01-13T10:30:00Z',
        stale: false,
        context: 'vessels.urn:mrn:imo:mmsi:123456789'
      }
      expect(alert.category).toBe('engine')
      expect(alert.context).toBeDefined()
    })
  })

  describe('AlertDefinition', () => {
    it('should accept a valid alert definition', () => {
      const definition: AlertDefinition = {
        alertType: 'engine.coolant.high',
        defaultPriority: 'alarm',
        latching: false,
        message: 'Engine coolant temperature is above threshold'
      }
      expect(definition.alertType).toBe('engine.coolant.high')
    })

    it('should accept optional escalation config', () => {
      const definition: AlertDefinition = {
        alertType: 'navigation.anchor.drag',
        defaultPriority: 'warning',
        latching: true,
        escalation: {
          toPriority: 'alarm',
          afterSeconds: 300
        },
        message: 'Anchor drag detected',
        category: 'navigation'
      }
      expect(definition.escalation?.toPriority).toBe('alarm')
    })
  })

  describe('IndicationState', () => {
    it('should accept valid indication state', () => {
      const indication: IndicationState = {
        audible: true,
        priority: 'alarm',
        flash: true,
        silenced: false,
        unacknowledgedCount: 3
      }
      expect(indication.unacknowledgedCount).toBe(3)
    })

    it('should accept null priority when no alerts', () => {
      const indication: IndicationState = {
        audible: false,
        priority: null,
        flash: false,
        silenced: false,
        unacknowledgedCount: 0
      }
      expect(indication.priority).toBeNull()
    })
  })

  describe('RaiseAlertRequest', () => {
    it('should accept minimal raise request', () => {
      const request: RaiseAlertRequest = {
        priority: 'caution',
        message: 'Battery voltage low'
      }
      expect(request.priority).toBe('caution')
    })

    it('should accept full raise request', () => {
      const request: RaiseAlertRequest = {
        priority: 'alarm',
        message: 'Engine overheating',
        category: 'engine',
        data: { temperature: 105, threshold: 95 },
        latching: true
      }
      expect(request.category).toBe('engine')
    })
  })

  describe('AlertFilter', () => {
    it('should accept single value filters', () => {
      const filter: AlertFilter = {
        state: 'unacknowledged',
        priority: 'alarm',
        category: 'engine',
        stale: false
      }
      expect(filter.state).toBe('unacknowledged')
    })

    it('should accept array value filters', () => {
      const filter: AlertFilter = {
        state: ['unacknowledged', 'rtn-unacknowledged'],
        priority: ['alarm', 'emergency']
      }
      expect(filter.state).toHaveLength(2)
    })
  })

  describe('HistoryQuery', () => {
    it('should accept date range query', () => {
      const query: HistoryQuery = {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-13T23:59:59Z',
        limit: 100,
        offset: 0
      }
      expect(query.from).toBeDefined()
    })

    it('should accept alert-specific query', () => {
      const query: HistoryQuery = {
        alertId: '123e4567-e89b-12d3-a456-426614174000'
      }
      expect(query.alertId).toBeDefined()
    })
  })

  describe('HistoryEntry', () => {
    it('should accept a raise event entry', () => {
      const entry: HistoryEntry = {
        id: 'hist-001',
        alertId: 'alert-001',
        eventType: 'raise',
        timestamp: '2026-01-13T10:00:00Z',
        newState: 'unacknowledged'
      }
      expect(entry.eventType).toBe('raise')
    })

    it('should accept an acknowledge event with user', () => {
      const entry: HistoryEntry = {
        id: 'hist-002',
        alertId: 'alert-001',
        eventType: 'acknowledge',
        timestamp: '2026-01-13T10:05:00Z',
        userId: 'captain',
        previousState: 'unacknowledged',
        newState: 'acknowledged'
      }
      expect(entry.userId).toBe('captain')
    })

    it('should accept an escalate event with priority change', () => {
      const entry: HistoryEntry = {
        id: 'hist-003',
        alertId: 'alert-001',
        eventType: 'escalate',
        timestamp: '2026-01-13T10:10:00Z',
        previousPriority: 'warning',
        newPriority: 'alarm'
      }
      expect(entry.newPriority).toBe('alarm')
    })
  })

  describe('HistoryEventType', () => {
    it('should accept all valid event types', () => {
      const eventTypes: HistoryEventType[] = [
        'raise',
        'acknowledge',
        'silence',
        'unsilence',
        'clear',
        'escalate'
      ]
      expect(eventTypes).toHaveLength(6)
    })
  })

  describe('IAlertStore', () => {
    it('should define the persistence interface', () => {
      // This test verifies the interface is importable and usable
      // Actual implementation tests will be in the store tests
      const mockStore: IAlertStore = {
        initialize: () => Promise.resolve(),
        close: () => Promise.resolve(),
        save: (_alert: Alert) => Promise.resolve(),
        get: (_id: string) => Promise.resolve(null),
        getAll: (_filter?: AlertFilter) => Promise.resolve([]),
        update: (_alert: Alert) => Promise.resolve(),
        delete: (_id: string) => Promise.resolve()
      }
      expect(typeof mockStore.initialize).toBe('function')
      expect(typeof mockStore.save).toBe('function')
      expect(typeof mockStore.getAll).toBe('function')
    })
  })
})
