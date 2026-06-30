# signalk-alert-manager

Signal K server plugin for centralized alert management following maritime and process industry standards.

## Why This Plugin?

Signal K has no built-in alert management. Maritime safety standards (IMO MSC.302(87), IEC 62682) require features that simply don't exist in the server: alert lifecycle tracking, operator acknowledgment, persistence across restarts, silencing, escalation, and audit trails.

signalk-alert-manager provides a standalone alert management system based on these standards. Alerts can be raised through multiple paths — a REST API, a plugin API for other Signal K plugins, incoming `alerts.*` deltas from devices, or automatically from existing `notifications.*` deltas — and all alerts receive the same lifecycle management regardless of how they entered the system.

### Relationship to Signal K Notifications

Signal K's `notifications.*` paths provide a simple signaling layer — a value at a path with a state and message. They were not designed for alert management and lack lifecycle, acknowledgment, persistence, and history. The alert manager is a separate system that can *ingest* notifications as one alert source among others, not a replacement or extension of the notification mechanism.

The comparison below summarizes the differences:

| Capability | Signal K Notifications | Alert Manager |
|---|---|---|
| Data model | Key-value at `notifications.*` paths | Alert objects with unique IDs, full metadata |
| States | `normal`, `nominal`, `alert`, `warn`, `alarm`, `emergency` | IEC 62682: unacknowledged, acknowledged, return-to-normal |
| Lifecycle | None — value replaced on update | Raise → acknowledge → clear with full tracking |
| Acknowledgment | Not supported | Per-alert, records who and when |
| Silencing | Not supported | Time-limited, configurable per priority |
| Escalation | Not supported | Automatic priority promotion on timeout |
| Persistence | In-memory only (lost on restart) | SQLite — survives restarts |
| History | None | Full audit trail with query API |
| Source tracking | `$source` field | Source liveness monitoring, stale detection |
| Priority model | Implicit in state string | Four explicit levels (IMO model) with defined behaviors |
| Creation | Zone triggers or manual deltas | REST API, plugin API, `alerts.*` deltas, and notification ingestion |

## Alert Model

### Priority Levels

Four priority levels follow the IMO model, from most to least urgent:

| Priority | When to Use | Audible | Requires Acknowledgment |
|---|---|---|---|
| **Emergency** | Immediate danger to life or vessel | Rapid 5-pulse burst, repeating | Yes |
| **Alarm** | Conditions requiring immediate attention | 3-pulse triplet, repeating | Yes |
| **Warning** | Conditions requiring precautionary attention | 2-pulse chime, repeating | Yes |
| **Caution** | Noteworthy conditions, not immediately hazardous | None | No |

All audible patterns repeat until the alert is acknowledged or silenced. Each priority has a distinct frequency (880/660/440 Hz) and pulse pattern inspired by IEC 60601-1-8.

### Alert Lifecycle

Alerts follow the IEC 62682 state model:

```
                 condition                    condition clears
  NORMAL ──────triggers──────► UNACKNOWLEDGED ──────────────────► RTN-UNACKNOWLEDGED
                                     │                                    │
                              operator acks                        operator acks
                                     │                                    │
                                     ▼          condition clears          ▼
                               ACKNOWLEDGED ──────────────────────► NORMAL
```

- **Unacknowledged**: Alert is active, operator has not yet responded. Visual indicators flash, audible alerts sound per priority.
- **Acknowledged**: Operator confirmed awareness. Visual indicators show steady, audible alerts stop.
- **Return-to-normal unacknowledged**: The triggering condition cleared before the operator acknowledged. Audible alert continues until acknowledged or silenced.

Caution-priority alerts skip acknowledgment — they clear automatically when the condition resolves.

### Latching

Some alerts represent one-shot events (e.g., waypoint arrival, anchor drag detected) where the triggering condition is momentary. Latching alerts remain active after the condition clears and must be explicitly acknowledged to dismiss.

### Silencing

Silencing suppresses audible indicators without acknowledging the alert. It is time-limited:
- Non-emergency alerts: configurable, default 120 seconds
- Emergencies: shorter limit, default 30 seconds
- A global "silence all" action affects all unacknowledged alerts (including return-to-normal unacknowledged)

### Escalation

Unacknowledged warnings automatically escalate to alarm priority after a configurable timeout (default: 5 minutes). This ensures ignored warnings eventually demand attention.

### Source Tracking

Each alert tracks its source. If a source stops sending updates, the alert is marked **stale** after a configurable timeout (default: 60 seconds). Stale alerts remain visible and actionable but are visually distinguished in the UI.

### Actors and Ownership

**Who creates alerts?** Alerts enter the system through four ingress paths:

- **Plugin API** — Signal K plugins raise alerts programmatically via `app.alertManager.raiseAlert()`, providing a `path` to identify the data point and a `$source` to identify themselves.
- **REST API** — Authenticated HTTP clients raise alerts via `POST /alerts`. The caller must provide a `path`; `$source` is optional and defaults to `'rest-api'`.
- **Alert deltas** — Devices and plugins can raise alerts by publishing Signal K deltas with `alerts.*` paths. See [Alert Delta Ingestion](#alert-delta-ingestion) below.
- **Notification ingestion** — The plugin intercepts incoming `notifications.*` deltas and transforms them into managed alerts. This is how zone-based alarms and other plugins that use the existing notification mechanism enter the alert system. The alert's `path` is derived from the notification path with the `notifications.` prefix stripped (e.g., `notifications.propulsion.main.coolantTemperature` → path `propulsion.main.coolantTemperature`).

Each alert is identified by its `path` (with optional `context` for multi-vessel deployments). When the same path is raised again, the existing alert is updated (message refreshed, priority escalated if higher) rather than creating a duplicate.

**Who can acknowledge, silence, and clear?** Any authenticated user can perform any operation on any alert, regardless of who raised it. There is no per-alert ownership or role-based restriction. This is intentional: in a bridge context, any watchkeeper must be able to respond to any alert immediately. The operator's identity is recorded for audit purposes (in `acknowledgedBy` and in the history log) but is not used for access control.

**Who manages alert state?** The `AlertManager` is the single source of truth. All state transitions — whether triggered by the REST API, the plugin API, or the notification transformer — pass through the AlertManager, which enforces the IEC 62682 state machine rules, manages escalation timers, and persists changes to the SQLite store. No external actor can modify alert state directly.

**Authentication** is handled entirely by the Signal K server. All REST API routes inherit the server's admin authentication middleware; unauthenticated requests are rejected before reaching the plugin. The plugin API has no authentication layer — any plugin running in the server process can call `app.alertManager`.

## Installation

### Prerequisites

- **Node.js 22+** (required for built-in `node:sqlite`)
- **Signal K server** running on Node.js 22+ with the `--experimental-sqlite` flag
- `@signalk/server-api` v2.10.0+ (peer dependency)

### Install

Install from the Signal K Appstore (Server → Appstore in the Admin UI), then enable the plugin under Server → Plugin Config.

#### Manual install

```bash
cd ~/.signalk
npm install signalk-alert-manager
```

#### Manual install on HaLOS

On HaLOS, Signal K runs in a Docker container:

```bash
sudo docker exec signalk-server npm install signalk-alert-manager --prefix /home/node/.signalk
sudo systemctl restart marine-signalk-server-container.service
```

## Configuration

All settings are optional — defaults are applied automatically.

| Setting | Default | Description |
|---|---|---|
| **Audio: Minimum Audible Priority** | `warning` | Lowest priority that triggers browser audio. Set to `off` to disable all audio. |
| **Silencing: Default Duration** | 120s | Maximum silence duration for non-emergency alerts |
| **Silencing: Emergency Duration** | 30s | Maximum silence duration for emergencies |
| **Escalation: Enabled** | `true` | Auto-escalate unacknowledged warnings to alarms |
| **Escalation: Timeout** | 300s | Seconds before warning escalates to alarm |
| **Source Timeout: Stale After** | 60s | Mark alert stale if source stops updating |
| **History: Retention** | 90 days | How long to keep alert history |
| **Dev: Enable Simulation** | `false` | Show simulation controls in the UI toolbar |

Configuration is accessible through the Signal K Admin UI plugin settings page or by editing `~/.signalk/plugin-config-data/signalk-alert-manager.json`.

## API Reference

All endpoints are under `/plugins/signalk-alert-manager/`. Authentication is handled by Signal K server middleware.

### Raise an Alert

```
POST /plugins/signalk-alert-manager/alerts
```

```bash
curl -X POST http://localhost:3000/plugins/signalk-alert-manager/alerts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "path": "propulsion.main.coolantTemperature",
    "priority": "alarm",
    "message": "Engine coolant temperature high",
    "group": "engine",
    "latching": false,
    "data": { "value": 95, "threshold": 90 }
  }'
```

Returns `201` with the created alert object.

### List Alerts

```
GET /plugins/signalk-alert-manager/alerts
GET /plugins/signalk-alert-manager/alerts?state=unacknowledged
GET /plugins/signalk-alert-manager/alerts?priority=alarm,emergency
GET /plugins/signalk-alert-manager/alerts?group=engine
GET /plugins/signalk-alert-manager/alerts?stale=true
```

### Get Single Alert

```
GET /plugins/signalk-alert-manager/alerts/{id}
```

### Acknowledge

```
POST /plugins/signalk-alert-manager/alerts/{id}/acknowledge
```

The authenticated user's identity is recorded in `acknowledgedBy`.

### Silence

```
POST /plugins/signalk-alert-manager/alerts/{id}/silence
```

Optional body: `{ "duration": 30 }` (seconds). If omitted, uses the configured maximum for the alert's priority.

### Silence All

```
POST /plugins/signalk-alert-manager/alerts/silence-all
```

### Clear Condition

```
PUT /plugins/signalk-alert-manager/alerts/{id}/condition
Content-Type: application/json

{ "active": false }
```

Used by sources to signal that the triggering condition has resolved.

### Alert History

```
GET /plugins/signalk-alert-manager/alerts/history
GET /plugins/signalk-alert-manager/alerts/history?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z
GET /plugins/signalk-alert-manager/alerts/history?alertId={id}
GET /plugins/signalk-alert-manager/alerts/history?eventType=raise,acknowledge
GET /plugins/signalk-alert-manager/alerts/history?limit=50&offset=100
```

Event types: `raise`, `acknowledge`, `silence`, `unsilence`, `clear`, `escalate`.

### UI Configuration

```
GET /plugins/signalk-alert-manager/config/ui
```

Returns browser-relevant settings (audio threshold, simulation mode).

## Plugin API

Other Signal K plugins can interact with alerts programmatically via `app.alertManager`:

```typescript
// Raise an alert
const alert = await app.alertManager.raiseAlert({
  $source: 'my-plugin',
  priority: 'warning',
  message: 'Anchor watch: vessel outside radius',
  group: 'navigation',
  latching: true
})

// Acknowledge
await app.alertManager.acknowledgeAlert(alert.id, 'operator-1')

// Clear condition
await app.alertManager.clearCondition(alert.id)

// Silence for 60 seconds (plugin API takes milliseconds; REST API takes seconds)
await app.alertManager.silenceAlert(alert.id, 60000)

// Silence all audible alerts
await app.alertManager.silenceAll()

// Query alerts
const emergencies = app.alertManager.getAlerts({ priority: 'emergency' })
const unacked = app.alertManager.getAlerts({ state: 'unacknowledged' })

// Register a reusable alert type (reserved for future use — definitions
// are stored but not yet consumed by raiseAlert)
app.alertManager.registerAlertType({
  alertType: 'engine.coolant.high',
  defaultPriority: 'alarm',
  latching: false,
  message: 'Engine coolant temperature high',
  group: 'engine'
})
```

TypeScript types are exported from the package for use in plugin development:

```typescript
import type {
  Alert,
  AlertPriority,
  AlertState,
  AlertManagerAPI,
  RaiseAlertRequest,
  AlertFilter,
  HistoryEntry
} from 'signalk-alert-manager'
```

## Signal K Integration

### Notification Ingestion

The plugin intercepts incoming `notifications.*` deltas and transforms them into managed alerts, providing a bridge for zone-based alarms and other plugins that use the existing notification mechanism. Signal K notification states map to alert priorities:

| SK Notification State | Alert Priority |
|---|---|
| `emergency` | Emergency |
| `alarm` | Alarm |
| `warn` | Warning |
| `alert` | Caution |
| `normal`, `nominal` | Clears the condition |

Notifications continue to flow through Signal K normally — the plugin subscribes non-destructively via `registerDeltaInputHandler`.

### Alert Delta Ingestion

Devices and plugins can raise alerts by publishing Signal K deltas with `alerts.*` paths. The portion after `alerts.` becomes the alert's `path` (e.g., delta path `alerts.propulsion.main.coolantTemperature` → alert path `propulsion.main.coolantTemperature`).

**Raise an alert:**

```json
{
  "updates": [{
    "values": [{
      "path": "alerts.propulsion.main.coolantTemperature",
      "value": {
        "priority": "alarm",
        "message": "Engine coolant temperature high",
        "group": "engine",
        "data": { "value": 95, "threshold": 90 },
        "latching": false
      }
    }]
  }]
}
```

| Field | Required | Description |
|---|---|---|
| `priority` | Yes | `emergency`, `alarm`, `warning`, or `caution` |
| `message` | Yes | Human-readable alert message |
| `group` | No | Grouping label (e.g., `"engine"`, `"navigation"`) |
| `data` | No | Arbitrary context object (non-array) |
| `latching` | No | Whether the alert latches (stays active after condition clears) |

Lifecycle fields (`id`, `state`, `silenced`, timestamps, etc.) are ignored — the AlertManager is authoritative for those.

Deltas with missing or invalid `priority` (not one of the four levels) or missing `message` are silently ignored. Check server debug logs (`signalk-alert-manager`) for diagnostics.

**Clear an alert condition** (two equivalent forms):

```json
{
  "updates": [{
    "values": [{
      "path": "alerts.propulsion.main.coolantTemperature",
      "value": null
    }]
  }]
}
```

```json
{
  "updates": [{
    "values": [{
      "path": "alerts.propulsion.main.coolantTemperature",
      "value": { "state": "normal" }
    }]
  }]
}
```

**Update behavior:** If a delta arrives for a path that already has an active alert with the same priority and message, it acts as a heartbeat — refreshing source liveness for all alerts from that `$source`, not just the one at the delta path. If priority or message changed, the alert is re-raised with the new values (returning it to unacknowledged state if it had been acknowledged).

Deltas published by the alert manager's own delta publisher (source label `alert-manager`) are ignored to prevent feedback loops.

### Delta Publishing

Alert state changes are published as Signal K deltas on `alerts.*` paths, keyed by the alert's origin Signal K path. Each delta contains one value: the full alert object at the corresponding path.

**Delta structure:**

```json
{
  "context": "vessels.self",
  "updates": [{
    "source": { "label": "alert-manager" },
    "timestamp": "2026-01-13T10:30:00.000Z",
    "values": [{
      "path": "alerts.propulsion.main.coolantTemperature",
      "value": {
        "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "path": "propulsion.main.coolantTemperature",
        "$source": "n2k-on-ve.can-bus.115",
        "priority": "alarm",
        "state": "unacknowledged",
        "condition": true,
        "latching": true,
        "silenced": false,
        "message": "Coolant temperature high",
        "raisedAt": "2026-01-13T10:30:00.000Z",
        "sourceOnline": true,
        "lastSourceUpdate": "2026-01-13T10:30:00.000Z",
        "stale": false
      }
    }]
  }]
}
```

**Alert lifecycle as deltas** — a single alert path receives updates as its state changes:

| Event | `state` | Notes |
|---|---|---|
| Raised | `unacknowledged` | New alert or re-raised |
| Acknowledged | `acknowledged` | Operator acknowledged |
| Condition cleared (latching) | `rtn-unacknowledged` | Condition resolved, awaiting ack |
| Silenced | `unacknowledged` | `silenced: true`, `silencedUntil` set |
| Escalated | `unacknowledged` | `priority` upgraded (e.g., warning → alarm) |
| Cleared | `normal` | Final value — alert fully resolved |

When an alert clears, the full alert object is published with `state: 'normal'`. This is the terminal value at the path — consumers should treat `normal` as "no active alert for this path".

**WebSocket subscription:**

```json
{
  "context": "vessels.self",
  "subscribe": [{ "path": "alerts.*", "minPeriod": 0 }]
}
```

## Web UI

The plugin provides a web interface accessible at the plugin's webapp URL in Signal K. Built with [Lit](https://lit.dev/) web components for framework-agnostic reuse.

**Alert List** — Full alert management view with priority-sorted list, acknowledge/silence controls, and a toolbar with global silence and optional simulation controls.

**Alert Detail** — Expanded view of a single alert showing full metadata, history timeline, and action controls. Accessible by selecting an alert in the list.

**Alert Banner** — Compact embeddable component showing the highest-priority unacknowledged alert, designed for use in other applications (chart plotters, dashboards). Expands to show all active alerts.

**Audio** — Browser-based audio alerts with different tones per priority level, respecting the configured minimum audible priority and silence state.

## Development

```bash
npm run build          # Compile TypeScript (plugin backend)
npm run build:ui       # Build UI with Vite (output to public/)
npm run dev:ui         # Vite dev server for UI development
npm test               # Run all Vitest tests
npm run test:ui        # Run UI component tests
npm run test:e2e       # Run end-to-end tests
npm run lint           # ESLint check
npm run format         # Prettier format
npm run ci             # Full CI check (typecheck + lint + format + test)
```

## Standards References

- [IMO MSC.302(87)](https://www.imo.org/en/OurWork/Safety/Pages/BridgeAlertManagement.aspx) — Performance Standards for Bridge Alert Management
- [IMO A.1021(26)](https://www.imo.org/en/KnowledgeCentre/IndexofIMOResolutions/Pages/A-2009-11.aspx) — Code on Alerts and Indicators
- IEC 62682:2023 — Management of alarm systems for the process industries
- [OpenBridge Design System](https://www.openbridge.no/) — Maritime UI design guidelines
- [Signal K Specification](https://signalk.org/specification/) — Signal K data model and notification schema
- [signalk-server#1857](https://github.com/SignalK/signalk-server/issues/1857) — Discussion on alert data model and lifecycle

## License

Apache License 2.0 — see [LICENSE](LICENSE).
