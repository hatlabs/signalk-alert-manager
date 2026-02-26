import { describe, it, expect, beforeEach } from 'vitest'
import {
  AlertStateMachine,
  createAlert,
  type CreateAlertParams
} from '../../src/core/AlertStateMachine.js'
import type { Alert, AlertPriority } from '../../src/types.js'

describe('AlertStateMachine', () => {
  let stateMachine: AlertStateMachine

  beforeEach(() => {
    stateMachine = new AlertStateMachine()
  })

  // Helper to create a test alert
  function makeAlert(overrides: Partial<CreateAlertParams> = {}): Alert {
    return createAlert({
      path: 'test.alert',
      $source: 'test-source',
      priority: 'alarm',
      message: 'Test alert',
      ...overrides
    })
  }

  // Helper to assert an alert is not null and return it
  function assertAlert(alert: Alert | null): Alert {
    if (alert === null) {
      throw new Error('Expected alert to be non-null')
    }
    return alert
  }

  describe('createAlert', () => {
    it('should create an alert in unacknowledged state', () => {
      const alert = makeAlert()

      expect(alert.state).toBe('unacknowledged')
      expect(alert.condition).toBe(true)
      expect(alert.silenced).toBe(false)
    })

    it('should generate a unique ID', () => {
      const alert1 = makeAlert()
      const alert2 = makeAlert()

      expect(alert1.id).toBeDefined()
      expect(alert2.id).toBeDefined()
      expect(alert1.id).not.toBe(alert2.id)
    })

    it('should set raisedAt timestamp', () => {
      const before = new Date().toISOString()
      const alert = makeAlert()
      const after = new Date().toISOString()

      expect(alert.raisedAt).toBeDefined()
      expect(alert.raisedAt >= before).toBe(true)
      expect(alert.raisedAt <= after).toBe(true)
    })

    it('should default latching to false', () => {
      const alert = makeAlert()
      expect(alert.latching).toBe(false)
    })

    it('should accept latching parameter', () => {
      const alert = makeAlert({ latching: true })
      expect(alert.latching).toBe(true)
    })

    it('should set sourceOnline to true', () => {
      const alert = makeAlert()
      expect(alert.sourceOnline).toBe(true)
    })

    it('should set stale to false', () => {
      const alert = makeAlert()
      expect(alert.stale).toBe(false)
    })
  })

  describe('acknowledge', () => {
    it('should transition from unacknowledged to acknowledged', () => {
      const alert = makeAlert()

      const result = stateMachine.acknowledge(alert)

      expect(result.cleared).toBe(false)
      expect(result.previousState).toBe('unacknowledged')
      expect(result.alert?.state).toBe('acknowledged')
    })

    it('should set acknowledgedAt timestamp', () => {
      const alert = makeAlert()

      const result = stateMachine.acknowledge(alert)

      expect(result.alert?.acknowledgedAt).toBeDefined()
    })

    it('should set acknowledgedBy when userId provided', () => {
      const alert = makeAlert()

      const result = stateMachine.acknowledge(alert, 'operator-1')

      expect(result.alert?.acknowledgedBy).toBe('operator-1')
    })

    it('should be idempotent on already-acknowledged alert', () => {
      const alert = makeAlert()
      const acked = assertAlert(stateMachine.acknowledge(alert).alert)

      const result = stateMachine.acknowledge(acked)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('acknowledged')
    })

    it('should clear RTN-unacknowledged alert', () => {
      const alert = makeAlert()
      // Simulate RTN state
      const rtnAlert: Alert = {
        ...alert,
        state: 'rtn-unacknowledged',
        condition: false
      }

      const result = stateMachine.acknowledge(rtnAlert)

      expect(result.cleared).toBe(true)
      expect(result.alert).toBeNull()
    })

    it('should clear latched alert with cleared condition', () => {
      const alert = makeAlert({ latching: true })
      // Simulate latched alert where condition cleared
      const latchedAlert: Alert = {
        ...alert,
        condition: false
      }

      const result = stateMachine.acknowledge(latchedAlert)

      expect(result.cleared).toBe(true)
      expect(result.alert).toBeNull()
    })

    it('should transition latched alert with active condition to acknowledged', () => {
      const alert = makeAlert({ latching: true })

      const result = stateMachine.acknowledge(alert)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('acknowledged')
    })
  })

  describe('clearCondition', () => {
    describe('for ack-required priorities (emergency, alarm, warning)', () => {
      const ackRequiredPriorities: AlertPriority[] = ['emergency', 'alarm', 'warning']

      ackRequiredPriorities.forEach((priority) => {
        it(`should transition ${priority} from unacknowledged to rtn-unacknowledged`, () => {
          const alert = makeAlert({ priority })

          const result = stateMachine.clearCondition(alert)

          expect(result.cleared).toBe(false)
          expect(result.previousState).toBe('unacknowledged')
          expect(result.alert?.state).toBe('rtn-unacknowledged')
          expect(result.alert?.condition).toBe(false)
        })
      })

      it('should clear acknowledged alert when condition clears', () => {
        const alert = makeAlert({ priority: 'alarm' })
        const acked = assertAlert(stateMachine.acknowledge(alert).alert)

        const result = stateMachine.clearCondition(acked)

        expect(result.cleared).toBe(true)
        expect(result.alert).toBeNull()
      })

      it('should set clearedAt timestamp when transitioning to RTN', () => {
        const alert = makeAlert({ priority: 'alarm' })

        const result = stateMachine.clearCondition(alert)

        expect(result.alert?.clearedAt).toBeDefined()
      })
    })

    describe('for caution priority', () => {
      it('should auto-clear caution alert without requiring ack', () => {
        const alert = makeAlert({ priority: 'caution' })

        const result = stateMachine.clearCondition(alert)

        expect(result.cleared).toBe(true)
        expect(result.alert).toBeNull()
      })

      it('should clear acknowledged caution alert', () => {
        const alert = makeAlert({ priority: 'caution' })
        const acked = assertAlert(stateMachine.acknowledge(alert).alert)

        const result = stateMachine.clearCondition(acked)

        expect(result.cleared).toBe(true)
        expect(result.alert).toBeNull()
      })
    })

    describe('for latched alerts', () => {
      it('should keep latched alert in unacknowledged state when condition clears', () => {
        const alert = makeAlert({ latching: true, priority: 'alarm' })

        const result = stateMachine.clearCondition(alert)

        expect(result.cleared).toBe(false)
        expect(result.alert?.state).toBe('unacknowledged')
        expect(result.alert?.condition).toBe(false)
      })

      it('should clear acknowledged latched alert when condition clears', () => {
        const alert = makeAlert({ latching: true, priority: 'alarm' })
        const acked = assertAlert(stateMachine.acknowledge(alert).alert)

        const result = stateMachine.clearCondition(acked)

        expect(result.cleared).toBe(true)
        expect(result.alert).toBeNull()
      })
    })

    it('should be idempotent on already-cleared condition', () => {
      const alert = makeAlert({ priority: 'alarm' })
      const rtn = assertAlert(stateMachine.clearCondition(alert).alert)

      const result = stateMachine.clearCondition(rtn)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('rtn-unacknowledged')
    })
  })

  describe('silence', () => {
    it('should set silenced to true', () => {
      const alert = makeAlert()
      const until = new Date(Date.now() + 30000)

      const result = stateMachine.silence(alert, until)

      expect(result.silenced).toBe(true)
    })

    it('should set silencedUntil timestamp', () => {
      const alert = makeAlert()
      const until = new Date(Date.now() + 30000)

      const result = stateMachine.silence(alert, until)

      expect(result.silencedUntil).toBe(until.toISOString())
    })

    it('should not change alert state', () => {
      const alert = makeAlert()
      const until = new Date(Date.now() + 30000)

      const result = stateMachine.silence(alert, until)

      expect(result.state).toBe(alert.state)
    })

    it('should work on acknowledged alerts', () => {
      const alert = makeAlert()
      const acked = assertAlert(stateMachine.acknowledge(alert).alert)
      const until = new Date(Date.now() + 30000)

      const result = stateMachine.silence(acked, until)

      expect(result.silenced).toBe(true)
      expect(result.state).toBe('acknowledged')
    })
  })

  describe('unsilence', () => {
    it('should set silenced to false', () => {
      const alert = makeAlert()
      const silenced = stateMachine.silence(alert, new Date(Date.now() + 30000))

      const result = stateMachine.unsilence(silenced)

      expect(result.silenced).toBe(false)
    })

    it('should clear silencedUntil', () => {
      const alert = makeAlert()
      const silenced = stateMachine.silence(alert, new Date(Date.now() + 30000))

      const result = stateMachine.unsilence(silenced)

      expect(result.silencedUntil).toBeUndefined()
    })

    it('should be idempotent on non-silenced alert', () => {
      const alert = makeAlert()

      const result = stateMachine.unsilence(alert)

      expect(result.silenced).toBe(false)
    })
  })

  describe('setCondition', () => {
    it('should reactivate an RTN-unacknowledged alert', () => {
      const alert = makeAlert({ priority: 'alarm' })
      const rtn = assertAlert(stateMachine.clearCondition(alert).alert)

      const result = stateMachine.setCondition(rtn, true)

      expect(result.cleared).toBe(false)
      expect(result.previousState).toBe('rtn-unacknowledged')
      expect(result.alert?.state).toBe('unacknowledged')
      expect(result.alert?.condition).toBe(true)
    })

    it('should clear clearedAt when reactivating an RTN-unacknowledged alert', () => {
      const alert = makeAlert({ priority: 'alarm' })
      const rtn = assertAlert(stateMachine.clearCondition(alert).alert)
      expect(rtn.clearedAt).toBeDefined()

      const result = stateMachine.setCondition(rtn, true)

      expect(result.alert?.clearedAt).toBeUndefined()
    })

    it('should not change acknowledged alert state when condition reactivates', () => {
      // Acknowledged alerts stay acknowledged even if condition reactivates
      const alert = makeAlert()
      const acked = assertAlert(stateMachine.acknowledge(alert).alert)

      const result = stateMachine.setCondition(acked, true)

      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('acknowledged')
      expect(result.alert?.condition).toBe(true)
    })

    it('should delegate to clearCondition when setting condition to false', () => {
      const alert = makeAlert({ priority: 'alarm' })

      const result = stateMachine.setCondition(alert, false)

      // Should behave like clearCondition: unacknowledged → rtn-unacknowledged
      expect(result.cleared).toBe(false)
      expect(result.alert?.state).toBe('rtn-unacknowledged')
      expect(result.alert?.condition).toBe(false)
    })

    it('should auto-clear caution alert when setting condition to false', () => {
      const alert = makeAlert({ priority: 'caution' })

      const result = stateMachine.setCondition(alert, false)

      // Caution alerts auto-clear
      expect(result.cleared).toBe(true)
      expect(result.alert).toBeNull()
    })
  })

  describe('requiresAcknowledgment', () => {
    it('should return true for emergency priority', () => {
      expect(AlertStateMachine.requiresAcknowledgment('emergency')).toBe(true)
    })

    it('should return true for alarm priority', () => {
      expect(AlertStateMachine.requiresAcknowledgment('alarm')).toBe(true)
    })

    it('should return true for warning priority', () => {
      expect(AlertStateMachine.requiresAcknowledgment('warning')).toBe(true)
    })

    it('should return false for caution priority', () => {
      expect(AlertStateMachine.requiresAcknowledgment('caution')).toBe(false)
    })
  })

  describe('isUnacknowledged', () => {
    it('should return true for unacknowledged state', () => {
      const alert = makeAlert()
      expect(AlertStateMachine.isUnacknowledged(alert)).toBe(true)
    })

    it('should return true for rtn-unacknowledged state', () => {
      const alert = makeAlert()
      const rtn = assertAlert(stateMachine.clearCondition(alert).alert)
      expect(AlertStateMachine.isUnacknowledged(rtn)).toBe(true)
    })

    it('should return false for acknowledged state', () => {
      const alert = makeAlert()
      const acked = assertAlert(stateMachine.acknowledge(alert).alert)
      expect(AlertStateMachine.isUnacknowledged(acked)).toBe(false)
    })
  })

  describe('immutability', () => {
    it('should not mutate input alert on acknowledge', () => {
      const alert = makeAlert()
      const originalState = alert.state

      stateMachine.acknowledge(alert)

      expect(alert.state).toBe(originalState)
    })

    it('should not mutate input alert on clearCondition', () => {
      const alert = makeAlert()
      const originalCondition = alert.condition

      stateMachine.clearCondition(alert)

      expect(alert.condition).toBe(originalCondition)
    })

    it('should not mutate input alert on silence', () => {
      const alert = makeAlert()
      const originalSilenced = alert.silenced

      stateMachine.silence(alert, new Date(Date.now() + 30000))

      expect(alert.silenced).toBe(originalSilenced)
    })
  })
})
