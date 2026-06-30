# NMEA 2000 Alert Model Mapping

How our alert state model — the IEC 62923-1 four-state lifecycle, with `silenced` as an orthogonal flag — relates to the NMEA 2000 alert PGNs, and why we chose an orthogonal model over N2K's composite state approach.

## NMEA 2000 Alert PGNs

### PGN 126983 — Alert

The primary alert status message. Key fields (28 bytes, 21 fields total):

| Field | Name | Type | Notes |
|-------|------|------|-------|
| 10 | Temporary Silence Status | Yes/No | Orthogonal boolean |
| 11 | Acknowledge Status | Yes/No | Orthogonal boolean |
| 12 | Escalation Status | Yes/No | Orthogonal boolean |
| 13 | Temporary Silence Support | Yes/No | Capability flag |
| 14 | Acknowledge Support | Yes/No | Capability flag |
| 15 | Escalation Support | Yes/No | Capability flag |
| 18 | Trigger Condition | ALERT_TRIGGER_CONDITION | Manual/Auto/Test/Disabled |
| 19 | Threshold Status | ALERT_THRESHOLD_STATUS | Normal/Exceeded/Extreme/Low/Acked/Awaiting Ack |
| 20 | Alert Priority | number | |
| 21 | Alert State | ALERT_STATE | Composite state (see below) |

### PGN 126984 — Alert Response

Operator response commands (25 bytes, 12 fields):

| Value | Response Command |
|-------|-----------------|
| 0 | Acknowledge |
| 1 | Temporary Silence |
| 2 | Test Command off |
| 3 | Test Command on |

### ALERT_STATE Enum

| Value | State |
|-------|-------|
| 0 | Disabled |
| 1 | Normal |
| 2 | Active |
| 3 | Silenced |
| 4 | Acknowledged |
| 5 | Awaiting Acknowledge |

### ALERT_TYPE Enum

| Value | Type |
|-------|------|
| 1 | Emergency Alarm |
| 2 | Alarm |
| 5 | Warning |
| 8 | Caution |

## N2K Uses Both Orthogonal and Composite Models

PGN 126983 carries **both** representations simultaneously:

- **Composite state** (field 21): A single ALERT_STATE enum that includes "Silenced" as a distinct value. Simple displays can use this directly.
- **Orthogonal booleans** (fields 10-12): Separate flags for silence, acknowledge, and escalation status. These carry the full truth that the composite state collapses.

The composite state is a derived convenience value. The individual status fields are the authoritative source.

## Why We Use the Orthogonal Model

Our state machine tracks `state` (normal/unacknowledged/acknowledged/rtn-unacknowledged) and `silenced` (boolean) independently. We considered adopting N2K's single "Silenced" state but rejected it because **silencing should not freeze the alert lifecycle**.

Consider: an operator silences a high-exhaust-temperature alert, then opens the raw water intake valve. In the orthogonal model, the state transitions from unacknowledged to rtn-unacknowledged while silenced — the operator sees confirmation that their fix worked. In a single-silenced-state model, the state remains "Silenced" until timeout, hiding the condition change and degrading situational awareness.

Silencing suppresses audio output. It should not suppress state machine progression. The underlying alert lifecycle must keep advancing so operators can observe the effect of their corrective actions.

## Mapping to N2K for Export

When emitting PGN 126983:

| Our State | Our silenced | N2K Alert State (field 21) | N2K Silence Status (field 10) |
|-----------|-------------|---------------------------|-------------------------------|
| normal | — | Normal (1) | No |
| unacknowledged | false | Active (2) | No |
| unacknowledged | true | Silenced (3) | Yes |
| acknowledged | false | Acknowledged (4) | No |
| acknowledged | true | Acknowledged (4) | Yes |
| rtn-unacknowledged | false | Awaiting Acknowledge (5) | No |
| rtn-unacknowledged | true | Awaiting Acknowledge (5) | Yes |

Note: for rtn-unacknowledged+silenced, field 21 emits "Awaiting Acknowledge" rather than "Silenced" because the condition change is more important information for N2K displays that only look at the composite state. The orthogonal field 10 still reflects that audio is suppressed.

Priority mapping:

| Our Priority | N2K ALERT_TYPE |
|-------------|----------------|
| emergency | Emergency Alarm (1) |
| alarm | Alarm (2) |
| warning | Warning (5) |
| caution | Caution (8) |

## Source

PGN definitions from [canboat](https://canboat.github.io/canboat/canboat.html) (reverse-engineered; PGN 126983-126985 are noted as "not fully reverse engineered").
