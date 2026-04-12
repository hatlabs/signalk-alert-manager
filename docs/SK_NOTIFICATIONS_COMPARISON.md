# Comparison: signalk-alert-manager vs Signal K Notifications API

A detailed comparison of the two alert/notification systems, covering state models, vocabulary, standards compatibility, and implementation status.

## 1. State Models

### Signal K Notifications API

The Notifications API uses `ALARM_STATE` as a severity level, not a lifecycle state:

| Value | Meaning |
|-------|---------|
| `nominal` | Within normal range |
| `normal` | Default/cleared state |
| `alert` | Caution — routine action needed |
| `warn` | Warning — immediate attention, not immediate action |
| `alarm` | Immediate action to prevent loss of life/equipment |
| `emergency` | Life-threatening condition |

Lifecycle state is tracked separately via `AlarmStatus` boolean flags:

```
{ silenced: boolean, acknowledged: boolean, canSilence: boolean, canAcknowledge: boolean, canClear: boolean }
```

The composite state is `(ALARM_STATE, silenced, acknowledged)`, and there is an **implicit state machine** with guard-enforced transitions in the `Alarm` class:

- `silence()` — throws if `!canSilence`, already silenced/acknowledged, or emergency. Sets `silenced = true`, removes `sound` from method.
- `acknowledge()` — throws if `!canAcknowledge` or already acknowledged. Sets `acknowledged = true`, adjusts method (emergency keeps visual; others get `[]`).
- `clear()` — throws if `!canClear`. Resets to `state = normal`, `silenced = false`, `acknowledged = false`.
- `update()` (PR #2560) — when state (severity) changes, resets `silenced = false` and `acknowledged = false` (reactivation behavior).

So the Notifications API does enforce transition rules — it's not just flag toggling. But the state machine is not formalized as named lifecycle states with an explicit transition table; it's encoded in guard clauses across the action methods.

### signalk-alert-manager

Uses a formal IEC 62682-based state machine with four lifecycle states orthogonal to priority:

| State | Condition Active | Acknowledged |
|-------|-----------------|--------------|
| normal | No | N/A |
| unacknowledged | Yes | No |
| acknowledged | Yes | Yes |
| rtn-unacknowledged | No | No |

Priority (emergency/alarm/warning/caution) is a separate dimension. Silencing is a third orthogonal dimension (`silenced: boolean` + `silencedUntil` timestamp).

State transitions are explicit and enforced:
- `unacknowledged → acknowledged` (operator ack)
- `unacknowledged → rtn-unacknowledged` (condition clears before ack)
- `acknowledged → normal/cleared` (condition clears after ack)
- `rtn-unacknowledged → normal/cleared` (operator ack)
- `acknowledged/rtn-unacknowledged → unacknowledged` (reactivation)

### Key Differences

Both systems have a state model, but they differ in what they formalize:

1. **Vocabulary inversion**: The Notifications API uses `state` for severity and `status` for lifecycle. The alert-manager uses `state` for lifecycle and `priority` for severity. The alert-manager aligns with IEC 62682/IMO terminology.

2. **Lifecycle granularity**: The alert-manager has an explicit rtn-unacknowledged state (condition cleared, ack pending). The Notifications API has no equivalent — when an external source sends `state: normal`, the notification goes directly to normal with no intermediate "you still need to acknowledge this" state.

3. **Temporal behavior**: The alert-manager enforces silence timeouts and escalation. The Notifications API's silence is permanent until another action occurs.

4. **Condition tracking**: The alert-manager separates the triggering condition (`condition: boolean`) from the lifecycle state. The Notifications API doesn't track conditions independently — the `state` (severity) field carries both "how bad" and "is it active."

## 2. Vocabulary

| Concept | Notifications API | alert-manager | NMEA 2000 | IMO/IEC |
|---------|------------------|---------------|-----------|---------|
| The thing itself | notification / alarm | alert | alert | alert |
| How bad | `state` (alarm_state) | `priority` | Alert Type | alert category/priority |
| Lifecycle position | `status` (booleans) | `state` (enum) | Alert State | state (A/B/C/D) |
| Audio suppression | `method` array manipulation | `silenced` boolean | Temporary Silence Status | silence |
| Operator response | `acknowledged` boolean | `state: acknowledged` | Acknowledge Status | acknowledge |

The Notifications API's use of "state" for severity and "status" for lifecycle is inverted from IMO/IEC usage. The alert-manager aligns with the standards vocabulary.

## 3. Standards Compatibility

### IMO MSC.302(87) / A.1021(26)

| Requirement | Notifications API | alert-manager |
|------------|------------------|---------------|
| Four priority levels (EA/A/W/C) | Yes (emergency/alarm/warn/alert) | Yes (emergency/alarm/warning/caution) |
| Acknowledge before clear (EA/A/W) | No enforcement — `clear()` works regardless | Yes — `clearCondition()` transitions to rtn-unacknowledged; ack required |
| Return-to-normal unacknowledged | Not modeled | Explicit state (rtn-unacknowledged) |
| Silence is temporary | No timeout — silence is permanent until cleared | Yes — configurable timeout, auto-unsilences |
| Escalation (W→A) | Not implemented | Yes — configurable timeout, automatic |
| Emergency cannot be silenced | Yes (enforced) | Yes (shorter silence duration, configurable) |

### IEC 62682

| Requirement | Notifications API | alert-manager |
|------------|------------------|---------------|
| 4-state model (A/B/C/D) | Not implemented | Implemented (normal/unacknowledged/acknowledged/rtn-unacknowledged) |
| Latching alerts | Not supported | Supported |
| State transitions enforced | No — actions are flag toggles | Yes — invalid transitions rejected |
| Shelving/suppression | Not implemented | Not implemented (deferred per spec) |

### NMEA 2000 (PGN 126983)

| Aspect | Notifications API | alert-manager |
|--------|------------------|---------------|
| N2K alert ingestion | Via `n2k-signalk` plugin → delta → notification | Via Signal K delta subscription |
| N2K state mapping | Maps `acknowledgeStatus`/`temporarySilenceStatus` to booleans | N2K mapping documented but not yet implemented |
| N2K Alert State field | Not mapped (only status booleans extracted) | Mapping table defined (see NMEA2000_ALERT_MAPPING.md) |
| N2K Alert Response (126984) | Not supported (no acknowledge-back to bus) | Not yet implemented |
| N2K priority mapping | emergency←EA, alarm←A, warn←W, alert←C | emergency←EA, alarm←A, warning←W, caution←C |

## 4. Feature Comparison

| Feature | Notifications API | alert-manager |
|---------|------------------|---------------|
| Raise via API | Yes (PR #2560 adds full raise/update) | Yes (via REST API and delta) |
| Raise via delta | Yes (external notifications) | Yes (primary ingestion path) |
| Acknowledge | Yes (sets boolean) | Yes (state transition) |
| Silence | Yes (removes 'sound' from method array) | Yes (orthogonal boolean + timeout) |
| Silence timeout | No | Yes (configurable per priority) |
| Silence all | Yes | Yes |
| Acknowledge all | Yes | No (per spec — ack requires individual attention) |
| Clear | Yes (API-originated only) | Yes (condition-driven, not operator-driven) |
| Update/escalate | Yes (PR #2560 adds update) | Yes (automatic W→A escalation) |
| MOB alarm | Yes (dedicated endpoint) | No (would be a specific alert definition) |
| Persistence | No (in-memory only) | Yes (JSON file store, survives restart) |
| History | No | Yes (event history with configurable retention) |
| Source liveness | No | Yes (stale detection when source goes offline) |
| Web UI | No (API only, consumers build their own) | Yes (Lit-based alert panel) |
| Plugin interface | Yes (PR #2560 expands it) | Yes (Signal K plugin API) |

## 5. Implementation Status

### Signal K Notifications API (in signalk-server)

**Released (merged to master):**
- Notification identification (UUID assignment)
- Status tracking (silenced/acknowledged booleans)
- Silence and acknowledge actions
- Silence all / acknowledge all
- Delta interception and processing
- N2K notification ingestion (via n2k-signalk)
- Method array management (visual/sound)
- OpenAPI documentation

**PR #2560 (open, not yet merged):**
- Raise notifications via API
- Update notification state/message
- Clear notifications
- MOB alarm
- List/get operations
- Plugin interface (getById, list, raise, update, clear, mob)
- `data` field for arbitrary payload
- `createdAt` and `position` fields
- Stronger type safety (branded NotificationId)
- AlarmRaiseOptions / AlarmUpdateOptions types

**Not implemented:**
- State machine / lifecycle enforcement
- Silence timeout
- Escalation
- Persistence
- History
- Return-to-normal state
- Latching
- Source liveness tracking

### signalk-alert-manager (plugin)

**Implemented:**
- Full IEC 62682 state machine (4 states)
- Priority levels (4) with distinct behaviors
- Silence with configurable timeout (per priority)
- Automatic escalation (W→A)
- Latching alerts
- Persistence (JSON file store)
- Alert history with retention
- Source liveness and stale detection
- REST API (raise, acknowledge, silence, clear, query)
- Delta publishing (Signal K integration)
- Lit-based web UI (alert list, detail, banner, history)
- Notification transformer (alert → Signal K v1 notification format)

**Not implemented:**
- N2K export (mapping documented, code not written)
- N2K acknowledge-back (PGN 126984 response)
- Shelving/suppression (IEC 62682 states E/F/G)
- Authorization model (deferred to Signal K auth)

## 6. Architectural Relationship

The two systems operate at different layers:

- **Notifications API** is part of the Signal K server core. It manages the wire format — how notifications appear in deltas, how they're identified, what actions can be taken via HTTP. It's a **transport and action layer**.

- **signalk-alert-manager** is a plugin that implements the **domain logic** — the alert lifecycle state machine, escalation rules, timing constraints, persistence. It consumes and produces Signal K deltas, and includes a `NotificationTransformer` that converts its alert model back into the Signal K notification format for interoperability.

They are complementary, not competing. The Notifications API provides the protocol-level infrastructure; the alert-manager provides the domain-level intelligence. The alert-manager's `NotificationTransformer` already bridges the gap by emitting standard Signal K notifications from its richer alert model.

## 7. Compatibility Considerations

### What works today

The alert-manager subscribes to Signal K deltas (including N2K-originated notifications) and maps them into its state machine. It publishes state changes back as Signal K notifications via `NotificationTransformer`. The Notifications API can then process these like any other notification.

### Potential friction

1. **Dual management**: If both systems process the same notification, they may fight over the `method` array and `status` flags. The Notifications API rewrites `method` on every delta; the alert-manager tracks its own state independently. This is manageable because the alert-manager publishes via `handleMessage` and the Notifications API processes inbound deltas — but the interaction needs care.

2. **Vocabulary mismatch**: The alert-manager uses `state` for lifecycle and `priority` for severity. The Notifications API uses `state` for severity and `status` for lifecycle flags. Any bridging code must translate carefully.

3. **Clear semantics**: The Notifications API treats clear as an operator action (`DELETE /notifications/{id}`). The alert-manager treats condition-clearing as a system event that may or may not result in alert removal (depending on ack state). These are fundamentally different models of "clearing."

4. **Acknowledge semantics**: In the Notifications API, acknowledge sets a boolean and removes alarm methods. In the alert-manager, acknowledge is a state transition that may clear the alert entirely (if condition already resolved) or transition to a new state. The alert-manager's model is richer but harder to map back to simple boolean flags.
