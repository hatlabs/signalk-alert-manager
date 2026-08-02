# signalk-alert-manager Specification

**Version**: 0.1.0 (Draft)
**Status**: Draft for Review
**Author**: Matti Airas
**Date**: 2026-01-13

## 1. Introduction

### 1.1 Purpose

signalk-alert-manager is a Signal K server plugin that provides centralized alert management based on the IMO bridge alert management model (MSC.302(87), realized in IEC 62923), with selected lifecycle concepts adapted from process-industry alarm practice (IEC 62682). It transforms the current ad-hoc Signal K notification model into a structured alert system with proper lifecycle management, prioritization, and acknowledgment workflows.

### 1.2 Background

The existing Signal K notification and alarm models are not well-defined. This plugin addresses that gap by implementing the marine bridge alert management (BAM) model:
- IMO MSC.302(87) "Performance Standards for Bridge Alert Management"
- IMO A.1021(26) "Code on Alerts and Indicators"
- IEC 62923-1 / -2 — the IEC realization of MSC.302(87) (operational requirements and the alert/indicator lists), and the marine home of the formal alert state model

It additionally borrows the **latching** alert concept from IEC 62682:2023 ("Management of alarm systems for the process industries"), which marine BAM does not define. IEC 62682's process-plant machinery (alarm rationalization, shelving, performance KPIs) is out of scope.

### 1.3 Terminology

Following panaaj's recommendation, this specification uses **Alert** as the primary term to avoid ambiguity with Signal K v1 "notifications" and "alarms".

| Term | Definition |
|------|-----------|
| **Alert** | Announcement of an abnormal situation or condition requiring attention (IEC 62923-1 3.1.8 / IMO MSC.302(87)) |
| **Acknowledge** | Operator action confirming recognition of an alert |
| **Silence** | Suppress audible indicators without acknowledging |
| **Latch** | Alert that remains active after its triggering condition returns to normal (concept borrowed from IEC 62682; not defined in marine BAM) |
| **Escalate** | Automatic promotion of an alert to higher priority after a timeout |

## 2. Alert Priorities

Following the IMO model, four alert priorities are defined:

| Priority | Name | Description | Requires Ack | Audible |
|----------|------|-------------|--------------|---------|
| **EA** | Emergency Alarm | Immediate danger to life or vessel; immediate action required | Yes | Continuous |
| **A** | Alarm | Conditions requiring immediate attention to maintain safe operation | Yes | Yes (silenceable; see §3.2) |
| **W** | Warning | Conditions requiring attention for precautionary reasons | Yes | Momentary |
| **C** | Caution | Conditions requiring attention but not immediately hazardous | No | None |

### 2.1 Priority Behavior

- **EA, A, W**: Must be acknowledged before clearing
- **C**: Auto-clears when condition returns to normal
- **Escalation**: Unacknowledged W alerts escalate to A after configurable timeout

## 3. Alert State Model

The lifecycle is the four-state alarm/warning model of marine bridge alert management (IEC 62923-1 Table 1 / Annex G — equivalently IEC 62682 states A–D), reduced for recreational use. It omits IEC 62682's process-plant states E/F/G (shelving, suppressed-by-design, out-of-service) and IEC 62923's `active – silenced` and `active – responsibility transferred` states (see §3.4). Silencing is modeled as an orthogonal flag rather than a state.

```
NORMAL ──────────(condition triggers)──────────► UNACKNOWLEDGED
UNACKNOWLEDGED ───(operator acknowledges)───────► ACKNOWLEDGED
UNACKNOWLEDGED ───(condition clears)────────────► RTN-UNACKNOWLEDGED
ACKNOWLEDGED ─────(condition clears)────────────► NORMAL
RTN-UNACKNOWLEDGED (operator acknowledges)──────► NORMAL
ACKNOWLEDGED / RTN-UNACKNOWLEDGED (re-triggers)─► UNACKNOWLEDGED
```

Priority (emergency / alarm / warning / caution) is an orthogonal dimension, as are `silenced` and the triggering `condition`.

### 3.1 State Definitions

| State | Condition active | Acknowledged | Visual | Audible |
|-------|------------------|--------------|--------|---------|
| normal | No | N/A | None | None |
| unacknowledged | Yes | No | Flashing | Yes (per priority) |
| acknowledged | Yes | Yes | Steady | None |
| rtn-unacknowledged | No | No | Flashing | Brief |

### 3.2 Silencing

- Silencing suppresses audible indicators without acknowledging the alert, and does not advance the lifecycle state — it is an orthogonal flag, and the escalation timer keeps running.
- Non-emergency alerts: silence auto-expires after a configurable timeout (default 120 s — `defaultMaxSilenceSeconds`). This deliberately exceeds IEC 62923-1 (6.3.4.3) 30 s bridge re-trigger; see §3.4.
- Emergency: shorter default (30 s — `emergencyMaxSilenceSeconds`).
- A global "silence all" action affects all currently sounding alerts.

### 3.3 Latched Alerts

Latching is borrowed from IEC 62682 (process industries); marine BAM does not define it. It suits one-shot marine events (e.g. waypoint arrival, anchor drag) whose triggering condition is momentary:
- The alert remains `unacknowledged` (active) even after the triggering condition clears.
- Acknowledging a latched alert automatically resets it to `normal`.
- Latching behavior is configurable per alert definition.

### 3.4 Deliberate deviations from full marine BAM

This plugin implements a recreational *subset* of IEC 62923 bridge alert management. The following deviations are intentional — chosen for a single-helm vessel rather than a SOLAS bridge with a watch team — and are documented here so they are not mistaken for omissions:

- **Silencing is an orthogonal flag, not a state.** IEC 62923-1 models `active – silenced` as a first-class state; we track `silenced` independently of the lifecycle state. The `(state, silenced)` pair reconstructs it, and this keeps audio-suppression separate from the lifecycle (matching the NMEA 2000 Temporary Silence Status field).
- **Longer silence durations.** Default 120 s for non-emergency alerts vs IEC 62923-1 (6.3.4.3) 30 s bridge re-trigger. On a one-person helm a constantly re-sounding alarm is counter-productive.
- **Emergency alerts are acknowledgeable.** IEC 62923-1 (Annex G, Fig. G.1) gives emergency a normal/active diagram with no acknowledge (audible handled per A.1021(26)). We let the operator acknowledge an emergency at the helm: most users are not trained on the alert model, and an un-dismissable emergency tone — e.g. an auto-MOB raised by a false-positive BLE-beacon range loss — would be unworkable.
- **No responsibility transfer.** IEC 62923-1 (Clause 6.9) defines `active – responsibility transferred` with ACN/ARC/HBT inter-equipment handover. There is no multi-cluster CAM network on a small craft.
- **No alert categories A/B/C.** IEC 62923-1 (6.2.2.2) categorizes alerts by *where* they may be acknowledged. On a single-display helm every alert is acknowledgeable in one place. (The plugin's `group` field is an unrelated UI grouping, not the IEC alert category.)
- **Escalation: change-to-alarm only.** IEC 62923-1 (6.3.7.1) also permits "repeat as warning"; we implement only the change-to-alarm option, within the IEC ≤5 min ceiling (default 300 s).
- **Alert identity.** We use a per-occurrence UUID plus the Signal K path; IEC 62923-2 uses a standardized alert identifier (type) plus an instance. Internal-only today; the gap for N2K/ALF export is tracked in #101.
- **Caution alerts are operator-dismissable.** IEC 62923-1 returns an alert to `normal` only when its triggering condition clears. Caution additionally accepts an explicit operator *dismiss*, which forces the condition inactive. Signal K notification sources are frequently one-shot — they emit the caution and never emit a matching `normal` — so without a dismiss such an alert stays on the list indefinitely. Dismiss is offered for caution only, in any state but `normal`; warning, alarm and emergency still require the condition to clear.

## 4. Alert Data Model

### 4.1 Alert Instance

```typescript
interface Alert {
  // Identity
  id: string;                    // Unique alert instance ID (UUID)
  path: string;                  // Signal K path identifying the alert (dedup key)
  $source: string;               // Signal K source reference (e.g., "n2k-on-ve.can-bus.115")
  source?: Record<string, unknown>; // Signal K structured source object, if available

  // Classification
  priority: 'emergency' | 'alarm' | 'warning' | 'caution';
  group?: string;                // UI grouping (e.g., "engine"); NOT the IEC alert category A/B/C

  // State
  state: 'normal' | 'unacknowledged' | 'acknowledged' | 'rtn-unacknowledged'; // 'normal' is the transient cleared/wire value
  silenced: boolean;
  silencedUntil?: string;        // ISO timestamp

  // Condition
  condition: boolean;            // Current condition state
  latching: boolean;             // Whether alert latches

  // Content
  message: string;               // Human-readable alert message
  data?: Record<string, any>;    // Additional context data

  // Timing
  raisedAt: string;              // ISO timestamp when first raised
  acknowledgedAt?: string;       // ISO timestamp when acknowledged
  acknowledgedBy?: string;       // User/client that acknowledged
  clearedAt?: string;            // ISO timestamp when condition cleared

  // Source tracking
  sourceOnline: boolean;         // Whether source is currently reachable
  lastSourceUpdate: string;      // Last update from source
  stale: boolean;                // Source went offline while alert active

  // Multi-vessel
  context?: string;              // Vessel context (e.g., "vessels.urn:mrn:imo:mmsi:123456789")
}
```

### 4.2 Alert Definition (for registered alert types)

```typescript
interface AlertDefinition {
  alertType: string;             // Unique type identifier
  defaultPriority: AlertPriority;
  latching: boolean;
  escalation?: {
    toPriority: AlertPriority;
    afterSeconds: number;
  };
  message: string;               // Template or static message
  group?: string;
}
```

## 5. Alert Sources

### 5.1 Supported Sources

1. **Signal K Notifications**: Existing `notifications.*` paths are intercepted and transformed
2. **Signal K Alert Deltas**: Deltas on `alerts.*` paths are ingested directly, allowing other plugins and external sources to raise alerts using the native alert data model without going through the notification mapping layer
3. **HTTP API**: External clients raise alerts via REST endpoints
4. **NMEA 2000**: PGN 126983 alerts received and published bidirectionally

### 5.2 Source Authentication

- Any authenticated source can raise alerts
- Sources are identified by their client/plugin ID
- Alert ownership tracks which source raised each alert

### 5.3 Source Offline Handling

When a source goes offline while its alerts are active:
- Alerts are marked as `stale: true`
- Alerts remain visible and actionable
- Stale indicator shown in UI
- Operator must manually clear or wait for source reconnection

## 6. API Specification

### 6.1 REST API

#### Raise Alert
```
POST /plugins/signalk-alert-manager/alerts
Content-Type: application/json

{
  "path": "propulsion.main.coolantTemperature",
  "priority": "alarm",
  "message": "Engine coolant temperature high",
  "group": "engine",
  "data": {
    "value": 95,
    "threshold": 90
  },
  "latching": false
}
```

#### List Alerts
```
GET /plugins/signalk-alert-manager/alerts
GET /plugins/signalk-alert-manager/alerts?state=unacknowledged
GET /plugins/signalk-alert-manager/alerts?priority=alarm,emergency
GET /plugins/signalk-alert-manager/alerts?group=engine
```

#### Get Single Alert
```
GET /plugins/signalk-alert-manager/alerts/{id}
```

#### Acknowledge Alert
```
POST /plugins/signalk-alert-manager/alerts/{id}/acknowledge
```

#### Escalate Alert
```
POST /plugins/signalk-alert-manager/alerts/{id}/escalate
Content-Type: application/json

{
  "priority": "alarm"
}
```

Escalates an alert to a higher priority. De-escalation is rejected (409). If the alert was acknowledged, it is reactivated to demand operator attention at the new priority level.

#### Silence Alert
```
POST /plugins/signalk-alert-manager/alerts/{id}/silence
Content-Type: application/json

{
  "duration": 30  // seconds, optional
}
```

#### Silence All
```
POST /plugins/signalk-alert-manager/alerts/silence-all
```

#### Clear Condition (for sources updating their alerts)
```
PUT /plugins/signalk-alert-manager/alerts/{id}/condition
Content-Type: application/json

{
  "active": false
}
```

### 6.2 WebSocket/Delta API

Alerts are published as Signal K deltas:

```json
{
  "context": "vessels.self",
  "updates": [{
    "source": { "label": "alert-manager" },
    "timestamp": "2026-01-13T10:30:00Z",
    "values": [{
      "path": "alerts.{originPath}",
      "value": { /* Alert object; state: 'normal' when cleared */ }
    }]
  }]
}
```

Clients subscribe to `alerts.*` paths for real-time updates.

### 6.3 Plugin ServerAPI

```typescript
interface AlertManagerAPI {
  raiseAlert(alert: RaiseAlertRequest): Promise<Alert>;
  escalateAlert(alertId: string, newPriority: AlertPriority): Promise<Alert>;
  clearCondition(alertId: string): Promise<void>;
  acknowledgeAlert(alertId: string): Promise<void>;
  silenceAlert(alertId: string, duration?: number): Promise<void>;
  silenceAll(): Promise<void>;
  getAlerts(filter?: AlertFilter): Promise<Alert[]>;
  getAlert(id: string): Promise<Alert | null>;
  registerAlertType(definition: AlertDefinition): void;
}
```

## 7. NMEA 2000 Integration

### 7.1 PGN 126983 - Alert

Bidirectional support:
- **Receive**: N2K alerts from MFDs and sensors are imported as managed alerts
- **Transmit**: Managed alerts are published to the N2K bus

### 7.2 Mapping

| N2K Alert Field | Alert Manager Field |
|-----------------|---------------------|
| Alert Type | group + alertType |
| Alert State | state mapping |
| Alert ID | id (generated/mapped) |
| Alert Text | message |

**Alert identity gap:** N2K (PGN 126983 ALF) and IEC 61162-1 expect a standardized *alert identifier* (a type code per IEC 62923-2 Annex A, or the manufacturer range) plus an *alert instance* — not our per-occurrence UUID or the Signal K path. A path→identifier mapping is required before N2K export; tracked in #101.

## 8. User Interface

### 8.1 Design Guidelines

The UI follows **OpenBridge** design guidelines for maritime alert interfaces:
- Color coding per priority (red/orange/yellow/blue)
- Flashing for unacknowledged alerts
- Clear acknowledge/silence controls
- Alert list with priority-based ordering

### 8.2 Core UI Components

1. **Alert Banner**: Embeddable component showing highest priority unacked alert (for use in other apps, e.g. chart plotters)
2. **Alert List**: Full list with alert count and global silence control
3. **Alert Detail**: Expanded view with full context and history
4. **Acknowledge Controls**: Per-alert and bulk actions
5. **Silence Controls**: Per-alert and global silence
6. **Dismiss Control**: Per-alert dismissal of caution alerts, forcing the triggering condition inactive (see §3.4)

### 8.3 Audio Indicators

- Browser audio playback for web UI
- Different tones per priority level
- Respects silence state

### 8.4 Alert Display Ordering

Per IMO MSC.302(87) Section 9.16:

> "As default, the alerts should be presented grouped in order of priority. Within the priorities the alerts should be displayed in the order in which they occur (sequence)."

Combined with Sections 7.3.3 and 7.3.9 (unacknowledged alerts flash, acknowledged alerts show steady), unacknowledged alerts requiring operator attention are displayed before acknowledged ones.

**Default sort order:**

1. **State**: Unacknowledged and RTN-unacknowledged alerts first, then acknowledged
2. **Priority**: Within each state group, highest priority first (EA → A → W → C)
3. **Time**: Within same state and priority, most recent on top — keyed off the time of the last lifecycle state change, not the original raise time

IEC 62923-1 6.4.2.2 refines the MSC.302(87) §9.16 "order of occurrence" rule: the active list is ordered most-recent-first by the time of the last state change (raise, acknowledge, clear, reactivate). Silence and un-silence are not state changes and never reorder the list, so silencing an alert does not move it. This keeps the alert whose situation most recently changed at the top, where it is most likely to need attention.

The sort order is fixed; marine alert lists are small enough that user-configurable sorting adds no value.

## 9. Persistence

### 9.1 Alert State Persistence

- Active alerts and their states persist across server restarts
- Uses Signal K's plugin data storage

### 9.2 Alert History

Full history log maintained:
- All alert raises, acknowledgments, clears
- State transitions with timestamps
- Operator actions with user identification
- Queryable via API

```
GET /plugins/signalk-alert-manager/alerts/history
GET /plugins/signalk-alert-manager/alerts/history?from=2026-01-01&to=2026-01-13
```

## 10. Configuration

```json
{
  "escalation": {
    "warningToAlarm": {
      "enabled": true,
      "timeoutSeconds": 300
    }
  },
  "silencing": {
    "defaultMaxSilenceSeconds": 120,
    "emergencyMaxSilenceSeconds": 30
  },
  "sourceTimeout": {
    "markStaleAfterSeconds": 60
  },
  "history": {
    "retentionDays": 90
  },
  "ui": {
    "audioEnabled": true,
    "showBanner": true
  }
}
```

## 11. MVP Scope

### 11.1 MVP Features (v1.0)

1. **Core Alert Lifecycle**
   - Raise, acknowledge, silence, clear
   - All four priority levels
   - Four-state lifecycle (normal / unacknowledged / acknowledged / rtn-unacknowledged)
   - Latching support

2. **APIs**
   - REST API for all operations
   - Delta/WebSocket for real-time updates
   - Plugin ServerAPI

3. **SK Integration**
   - Transform existing `notifications.*` paths
   - Persist across restarts

4. **Basic Web UI**
   - Alert list
   - Acknowledge/silence controls
   - Browser audio

### 11.2 Post-MVP Enhancements

1. **NMEA 2000 PGN 126983** (v1.1)
2. **Alert History with Query API** (v1.1)
3. **Escalation** (v1.2)
4. **OpenBridge-compliant UI polish** (v1.2)
5. **External Hardware API** (v1.3)
6. **Alert Aggregation/Grouping** (v2.0)

## 12. References

- [IMO MSC.302(87)](https://www.imo.org/en/OurWork/Safety/Pages/BridgeAlertManagement.aspx) - Bridge Alert Management Performance Standards
- [IMO A.1021(26)](https://www.imo.org/en/KnowledgeCentre/IndexofIMOResolutions/Pages/A-2009-11.aspx) - Code on Alerts and Indicators
- IEC 62923-1:2018 - Bridge alert management: operational and performance requirements (IEC realization of MSC.302(87); source of the formal alert state model)
- IEC 62923-2:2018 - Bridge alert management: alert and indicator lists
- IEC 62682:2023 - Management of alarm systems for the process industries (source of the borrowed latching concept; otherwise out of scope)
- [OpenBridge Design System](https://www.openbridge.no/)
- [Signal K Specification](https://signalk.org/specification/)
- [GitHub Issue #1857](https://github.com/SignalK/signalk-server/issues/1857) - Data model and lifecycle for alerts

## 13. Design Decisions

### 13.1 Notifications vs Alerts

Existing Signal K v1 notifications remain as-is. The alert manager is a **separate, complementary concept**:
- **Notifications**: Lightweight, informational, existing SK behavior
- **Alerts**: Managed lifecycle with acknowledgment, silencing, escalation

Alert sources may choose to raise alerts in response to notifications, but the systems are decoupled.

### 13.2 Multi-vessel Scope

In multi-vessel deployments, a **single consolidated view** aggregates alerts from all vessel contexts. Each alert retains its vessel context for identification.

## 14. Open Questions

1. **Authorization**: What permissions model for who can acknowledge/silence alerts? (Defer to SK's existing auth model?)
