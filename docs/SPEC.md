# signalk-alert-manager Specification

**Version**: 0.1.0 (Draft)
**Status**: Draft for Review
**Author**: Matti Airas
**Date**: 2026-01-13

## 1. Introduction

### 1.1 Purpose

signalk-alert-manager is a Signal K server plugin that provides centralized alert management following maritime (IMO) and process industry (IEC) standards. It transforms the current ad-hoc Signal K notification model into a structured alert system with proper lifecycle management, prioritization, and acknowledgment workflows.

### 1.2 Background

The existing Signal K notification and alarm models are not well-defined. This plugin addresses that gap by implementing:
- IMO MSC.302(87) "Performance Standards for Bridge Alert Management"
- IMO A.1021(26) "Code on Alerts and Indicators"
- IEC 62682:2023 "Management of alarm systems for the process industries"

### 1.3 Terminology

Following panaaj's recommendation, this specification uses **Alert** as the primary term to avoid ambiguity with Signal K v1 "notifications" and "alarms".

| Term | Definition (per IEC 62682) |
|------|---------------------------|
| **Alert** | Audible and/or visible means of indicating an equipment malfunction, process deviation, or abnormal condition requiring response |
| **Acknowledge** | Operator action confirming recognition of an alert |
| **Silence** | Suppress audible indicators without acknowledging |
| **Latch** | Alert that remains active after triggering condition returns to normal |
| **Escalate** | Automatic promotion of alert to higher priority after timeout |

## 2. Alert Priorities

Following the IMO model, four alert priorities are defined:

| Priority | Name | Description | Requires Ack | Audible |
|----------|------|-------------|--------------|---------|
| **EA** | Emergency Alarm | Immediate danger to life or vessel; immediate action required | Yes | Continuous |
| **A** | Alarm | Conditions requiring immediate attention to maintain safe operation | Yes | Yes (can silence 30s) |
| **W** | Warning | Conditions requiring attention for precautionary reasons | Yes | Momentary |
| **C** | Caution | Conditions requiring attention but not immediately hazardous | No | None |

### 2.1 Priority Behavior

- **EA, A, W**: Must be acknowledged before clearing
- **C**: Auto-clears when condition returns to normal
- **Escalation**: Unacknowledged W alerts escalate to A after configurable timeout

## 3. Alert State Model

Based on IEC 62682, excluding states E, F, G (Shelving, Suppressed by Design, Out of Service):

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
    ┌───────────────────────────┐                        │
    │     A: NORMAL             │                        │
    │   (No alert condition)    │                        │
    └───────────────────────────┘                        │
           │                 ▲                           │
           │ condition       │ condition                 │
           │ triggers        │ clears + acked            │
           ▼                 │                           │
    ┌───────────────────────────┐                        │
    │  B: UNACKNOWLEDGED        │                        │
    │     ACTIVE                │──────────┐             │
    │ (Alert active, not acked) │          │             │
    └───────────────────────────┘          │             │
           │                               │             │
           │ operator                      │ condition   │
           │ acknowledges                  │ clears      │
           ▼                               ▼             │
    ┌───────────────────────────┐   ┌───────────────────────────┐
    │  C: ACKNOWLEDGED          │   │  D: RETURN TO NORMAL      │
    │     ACTIVE                │   │     UNACKNOWLEDGED        │
    │ (Alert active, acked)     │   │ (Condition cleared,       │
    └───────────────────────────┘   │  awaiting ack)            │
           │                        └───────────────────────────┘
           │ condition                     │
           │ clears                        │ operator
           │                               │ acknowledges
           ▼                               │
           └───────────────────────────────┘
```

### 3.1 State Definitions

| State | Code | Condition | Acknowledged | Visual | Audible |
|-------|------|-----------|--------------|--------|---------|
| Normal | A | No | N/A | None | None |
| Unacked Active | B | Yes | No | Flashing | Yes (per priority) |
| Acked Active | C | Yes | Yes | Steady | None |
| RTN Unacked | D | No | No | Flashing | Brief |

### 3.2 Silencing

- Silencing suppresses audible indicators without acknowledging
- For priority A: silencing is temporary (30 seconds, configurable)
- For priority EA: silencing may have shorter duration or require reconfirmation
- Global silence action affects all currently sounding alerts

### 3.3 Latched Alerts

For one-shot events (e.g., waypoint arrival, anchor drag):
- Alert remains in state B even after triggering condition clears
- Acknowledging a latched alert automatically resets it to Normal
- Latching behavior is configurable per alert definition

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
  category?: string;             // Optional grouping (e.g., "engine", "navigation")

  // State
  state: 'unacknowledged' | 'acknowledged' | 'rtn-unacknowledged';
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
  category?: string;
}
```

## 5. Alert Sources

### 5.1 Supported Sources

1. **Signal K Notifications**: Existing `notifications.*` paths are intercepted and transformed
2. **Plugin API**: Other plugins raise alerts via ServerAPI methods
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
  "category": "engine",
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
GET /plugins/signalk-alert-manager/alerts?category=engine
```

#### Get Single Alert
```
GET /plugins/signalk-alert-manager/alerts/{id}
```

#### Acknowledge Alert
```
POST /plugins/signalk-alert-manager/alerts/{id}/acknowledge
```

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
      "path": "alerts.active.{id}",
      "value": { /* Alert object */ }
    }]
  }]
}
```

Clients subscribe to `alerts.*` paths for real-time updates.

### 6.3 Plugin ServerAPI

```typescript
interface AlertManagerAPI {
  raiseAlert(alert: RaiseAlertRequest): Promise<Alert>;
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
| Alert Type | category + alertType |
| Alert State | state mapping |
| Alert ID | id (generated/mapped) |
| Alert Text | message |

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
3. **Time**: Within same state and priority, oldest first (order of occurrence)

The "oldest first" ordering within a group ensures the longest-standing alert is most prominent — the one the operator has been ignoring longest demands the most attention.

The sort order is fixed; marine alert lists are small enough that user-configurable sorting adds no value.

### 8.5 External Hardware API

For physical alarm panels, buzzers, and displays:

```
GET /plugins/signalk-alert-manager/alerts/indication
```

Returns current indication state:
```json
{
  "audible": true,
  "priority": "alarm",
  "flash": true,
  "silenced": false,
  "unacknowledgedCount": 3
}
```

WebSocket subscription available for real-time indication updates.

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
    "alarmMaxSeconds": 30,
    "emergencyMaxSeconds": 10
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
   - State model (A, B, C, D)
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
- IEC 62682:2023 - Management of alarm systems for the process industries
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
