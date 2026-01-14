# Implementation Plan: Issue #7 - Alert State Machine

## Overview

Implement the IEC 62682-based alert state machine that manages alert lifecycle transitions.

## State Model (per SPEC.md Section 3)

```
States:
- A (Normal): No alert condition - represented by absence of alert
- B (Unacknowledged Active): Alert active, not acknowledged
- C (Acknowledged Active): Alert active, acknowledged
- D (RTN Unacknowledged): Condition cleared, awaiting acknowledgment

Note: State A is implicit - when an alert transitions to Normal, it is removed
from the active alerts. The state machine only manages alerts in states B, C, D.
```

## State Transitions

| From | To | Trigger | Conditions |
|------|-----|---------|------------|
| - | B | condition triggers | New alert raised |
| B | C | acknowledge() | - |
| C | A (removed) | condition clears | - |
| B | D | condition clears | priority requires ack (EA/A/W), non-latching |
| B | B | condition clears | latching=true (stays in B) |
| B | A (removed) | condition clears | priority=caution (auto-clears) |
| D | A (removed) | acknowledge() | - |

## Priority-Specific Behavior

- **emergency, alarm, warning**: Must be acknowledged before clearing (B→D→A)
- **caution**: Auto-clears when condition returns to normal (B→A directly)

## Latching Behavior

- Latched alerts stay in state B even after condition clears
- Acknowledging a latched alert with cleared condition resets to Normal
- If condition is still active when acknowledged, moves to C

## Silencing

The state machine tracks silencing but doesn't enforce timeouts (that's the AlertManager's job):
- `silence(until: Date)`: Sets silenced=true, silencedUntil=timestamp
- `unsilence()`: Clears silenced flag
- Silencing is orthogonal to state transitions

## Interface Design

```typescript
interface StateTransitionResult {
  alert: Alert           // The updated alert (or null if cleared)
  cleared: boolean       // Whether the alert was cleared (removed)
  previousState: AlertState
}

class AlertStateMachine {
  // State transitions
  acknowledge(alert: Alert, userId?: string): StateTransitionResult
  clearCondition(alert: Alert): StateTransitionResult

  // Silencing (doesn't change state)
  silence(alert: Alert, until: Date): Alert
  unsilence(alert: Alert): Alert

  // Factory for creating new alerts (initial state B)
  static createAlert(params: CreateAlertParams): Alert
}
```

## Pure Functions Approach

The state machine will be implemented as pure functions that take an alert
and return a new alert (or indicate the alert should be cleared). This:
- Makes testing straightforward
- Avoids side effects
- Allows the AlertManager to handle persistence

## Test Scenarios

### State Transitions
1. New alert starts in state B (unacknowledged)
2. B → C: acknowledge transitions to acknowledged
3. C → cleared: condition clear removes the alert
4. B → D: condition clear on ack-required priority
5. B → cleared: condition clear on caution priority (auto-clear)
6. D → cleared: acknowledge on RTN alert removes it

### Latching
7. Latched alert stays in B when condition clears
8. Acknowledge on latched alert with cleared condition → cleared
9. Acknowledge on latched alert with active condition → C

### Silencing
10. silence() sets silenced=true and silencedUntil
11. unsilence() clears silenced flag
12. Silencing doesn't affect state transitions

### Edge Cases
13. Acknowledge on already-acknowledged alert is idempotent
14. Clear condition on already-cleared condition is idempotent
15. Acknowledge on caution priority works (even though not required)

## Files to Create

- `src/core/AlertStateMachine.ts` - State machine implementation
- `test/core/AlertStateMachine.test.ts` - Comprehensive tests

## Dependencies

Uses existing types from `src/types.ts`:
- `Alert`
- `AlertState`
- `AlertPriority`
