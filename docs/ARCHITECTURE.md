# signalk-alert-manager Architecture

**Version**: 0.1.0
**Last Updated**: 2026-01-13

## 1. Overview

signalk-alert-manager is a Signal K server plugin that provides centralized alert management. It runs within the Signal K server process and integrates with the server's plugin infrastructure.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Signal K Server                               │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    signalk-alert-manager                        │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │ │
│  │  │  Alert Core  │  │  Alert Store │  │  SK Integration      │  │ │
│  │  │  (State      │  │  (Persistence│  │  (Notification       │  │ │
│  │  │   Machine)   │  │   & History) │  │   Transformer)       │  │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │ │
│  │         │                 │                      │              │ │
│  │         └─────────────────┼──────────────────────┘              │ │
│  │                           │                                     │ │
│  │  ┌──────────────┐  ┌──────┴───────┐  ┌──────────────────────┐  │ │
│  │  │   REST API   │  │ Delta/WS     │  │     Web UI           │  │ │
│  │  │   Handlers   │  │ Publisher    │  │   (Alert Panel)      │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. System Components

### 2.1 Alert Core

The central state machine managing alert lifecycle.

**Responsibilities:**
- Enforce alert lifecycle state transitions (IEC 62923-1 model)
- Handle acknowledgment, silencing, and clearing
- Manage escalation timers
- Track source liveness and mark stale alerts

**Key Classes:**
- `AlertStateMachine` - Implements state transitions
- `AlertManager` - Orchestrates alert operations
- `EscalationTimer` - Handles W→A escalation

### 2.2 Alert Store

Persistence layer for alerts and history.

**Responsibilities:**
- Persist active alerts across restarts
- Maintain alert history log
- Provide query interface for filtering/sorting

**Storage:**
- Uses Signal K's `app.savePluginOptions()` / `app.readPluginOptions()` for configuration
- Uses `app.getDataDirPath()` for database location
- **SQLite** via Node.js 22+ built-in `node:sqlite` module

**Note:** Requires Node.js 22+ with `--experimental-sqlite` flag. The synchronous `DatabaseSync` API is well-suited for plugin use.

### 2.3 SK Integration

Bridges existing Signal K data paths with the alert system.

**Responsibilities:**
- Subscribe to `notifications.*` delta stream and transform SK notifications to managed alerts
- Subscribe to `alerts.*` delta stream and ingest alerts using the native alert data model
- Map SK notification states (`normal`, `alert`, `warn`, `alarm`, `emergency`) to alert priorities
- Publish alert state changes as SK deltas

**State Mapping:**
| SK Notification State | Alert Priority |
|----------------------|----------------|
| `emergency` | Emergency (EA) |
| `alarm` | Alarm (A) |
| `warn`, `warning` | Warning (W) |
| `alert` | Caution (C) |
| `normal`, `nominal` | Clear condition |

### 2.4 REST API

HTTP endpoints for alert operations.

**Base Path:** `/plugins/signalk-alert-manager/`

Standard Signal K plugin API path. Future consideration: propose `/signalk/v2/api/alerts` to SK spec if this becomes a reference implementation.

**Endpoints:**
- `GET /alerts` - List alerts with filtering
- `GET /alerts/:id` - Get single alert
- `POST /alerts` - Raise new alert
- `POST /alerts/:id/acknowledge` - Acknowledge alert
- `POST /alerts/:id/silence` - Silence alert
- `POST /alerts/silence-all` - Global silence
- `PUT /alerts/:id/condition` - Update condition state
- `GET /alerts/indication` - Current indication state for hardware
- `GET /alerts/history` - Query alert history

Uses Express router via `plugin.registerWithRouter()`.

### 2.5 Delta Publisher

Real-time alert updates via Signal K delta mechanism.

**Responsibilities:**
- Publish alert changes to `alerts.*` paths, keyed by origin path
- Handle multi-vessel context

**Delta Structure:**
```
vessels.self.alerts.<originPath> = Alert object (state: 'normal' when cleared)
```

### 2.6 Web UI

Browser-based alert management interface.

**Technology:** TBD - requires investigation for maximum embedding flexibility.

**Considerations:**
- Components should be reusable in other projects (KIP dashboard, Freeboard)
- Options under evaluation:
  - **Lit Web Components**: Framework-agnostic, aligns with OpenBridge approach
  - **React with web component export**: Build in React, export via tools like @lit/react
  - **Vanilla + CSS**: Maximum portability, no framework dependencies
- OpenBridge web components library (Lit-based) releases publicly in March 2026

**Components:**
- `AlertBanner` - Top notification bar
- `AlertList` - Filterable alert list
- `AlertCard` - Individual alert display
- `AlertControls` - Acknowledge/silence buttons
- `AudioPlayer` - Browser audio playback

**Styling:** OpenBridge design language (colors, patterns, accessibility)

## 3. Data Models

### 3.1 Core Types

```typescript
// Alert priorities (IMO model)
type AlertPriority = 'emergency' | 'alarm' | 'warning' | 'caution';

// Alert lifecycle states (IEC 62923-1 four-state subset)
type AlertState = 'normal' | 'unacknowledged' | 'acknowledged' | 'rtn-unacknowledged';

// Full alert instance
interface Alert {
  id: string;
  path: string;                  // Signal K path (dedup key with context)
  $source: string;               // Signal K source reference
  source?: Record<string, unknown>; // Structured source object
  priority: AlertPriority;
  state: AlertState;
  condition: boolean;
  latching: boolean;
  silenced: boolean;
  silencedUntil?: string;
  message: string;
  category?: string;
  data?: Record<string, unknown>;
  raisedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  clearedAt?: string;
  sourceOnline: boolean;
  lastSourceUpdate: string;
  stale: boolean;
  context?: string;  // vessel context for multi-vessel
}

// Alert definition for registered types
interface AlertDefinition {
  alertType: string;
  defaultPriority: AlertPriority;
  latching: boolean;
  escalation?: {
    toPriority: AlertPriority;
    afterSeconds: number;
  };
  message: string;
  category?: string;
}

```

### 3.2 API Request/Response Types

```typescript
interface RaiseAlertRequest {
  priority: AlertPriority;
  message: string;
  category?: string;
  data?: Record<string, unknown>;
  latching?: boolean;
}

interface AlertFilter {
  state?: AlertState | AlertState[];
  priority?: AlertPriority | AlertPriority[];
  category?: string;
  stale?: boolean;
}

interface HistoryQuery {
  from?: string;  // ISO date
  to?: string;    // ISO date
  alertId?: string;
  limit?: number;
  offset?: number;
}
```

## 4. Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Language | TypeScript | Type safety, SK ecosystem standard |
| Runtime | Node.js 22+ | Required for built-in SQLite |
| HTTP Framework | Express | Provided by SK server |
| State Management | Internal classes | Simple, no external dependencies |
| Persistence | SQLite (`node:sqlite`) | Built-in, efficient queries, single-file database |
| Web UI | TBD | Investigating for embedding flexibility |
| Testing | Jest / Vitest | SK ecosystem standard |
| Linting | ESLint + Prettier | SK ecosystem standard |

## 5. Integration Points

### 5.1 Signal K Server API

The plugin uses these ServerAPI methods:

```typescript
// Delta handling
app.handleMessage(pluginId, delta)
app.streambundle.getSelfStream(path)

// Storage
app.getDataDirPath()
app.savePluginOptions(options)
app.readPluginOptions()

// Logging
app.debug(message)
app.error(message)

// Registration
plugin.registerWithRouter(router)
```

### 5.2 Delta Ingress

The plugin registers two delta input handlers to intercept incoming deltas:

**Notification ingress** (`notifications.*` paths):
```typescript
app.registerDeltaInputHandler((delta, next) => {
  delta.updates.forEach(update => {
    update.values.forEach(pathValue => {
      if (pathValue.path.startsWith('notifications.')) {
        // Transform SK notification to managed alert
      }
    })
  })
  next(delta) // Pass through to normal processing
})
```

**Alert delta ingress** (`alerts.*` paths):
```typescript
app.registerDeltaInputHandler((delta, next) => {
  delta.updates.forEach(update => {
    update.values.forEach(pathValue => {
      if (pathValue.path.startsWith('alerts.')) {
        // Ingest alert using native alert data model
        // Supports raise (with priority + message) and clear (null value)
      }
    })
  })
  next(delta) // Pass through to normal processing
})
```

The alert delta ingress allows other plugins and external sources to raise alerts using the alert manager's native data model, bypassing the notification-to-alert mapping layer.

### 5.3 Plugin API Export

Expose AlertManagerAPI for other plugins:

```typescript
// In plugin start()
app.alertManager = {
  raiseAlert,
  clearCondition,
  acknowledgeAlert,
  silenceAlert,
  getAlerts,
  registerAlertType
}
```

## 6. Security Considerations

### 6.1 Authentication

- REST API endpoints inherit Signal K server authentication
- WebSocket connections use SK's existing auth tokens
- Alert acknowledgment logs user identity when available

### 6.2 Authorization

- Defer to Signal K's existing permission model
- All authenticated users can view alerts
- Alert operations (ack, silence) require write permission
- Future: consider role-based access for critical operations

### 6.3 Input Validation

- Validate all API inputs at boundary
- Sanitize alert messages to prevent XSS in UI
- Limit message length and data payload size

## 7. File Structure

```
signalk-alert-manager/
├── docs/
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   └── IMPLEMENTATION_CHECKLIST.md
├── src/
│   ├── index.ts                 # Plugin entry point
│   ├── types.ts                 # TypeScript type definitions
│   ├── core/
│   │   ├── AlertManager.ts      # Main orchestrator
│   │   ├── AlertStateMachine.ts # State transitions
│   │   ├── EscalationTimer.ts   # Escalation handling
│   │   └── index.ts
│   ├── store/
│   │   ├── AlertStore.ts        # Persistence layer
│   │   ├── HistoryStore.ts      # History logging
│   │   └── index.ts
│   ├── integration/
│   │   ├── NotificationTransformer.ts  # SK notification bridge
│   │   ├── AlertDeltaTransformer.ts    # alerts.* delta ingress
│   │   ├── DeltaPublisher.ts           # Delta output
│   │   └── index.ts
│   ├── api/
│   │   ├── routes.ts            # REST API handlers
│   │   ├── openApi.json         # OpenAPI spec
│   │   └── index.ts
│   └── ui/
│       ├── public/
│       │   └── index.html
│       └── src/
│           ├── App.tsx
│           ├── components/
│           │   ├── AlertBanner.tsx
│           │   ├── AlertList.tsx
│           │   ├── AlertCard.tsx
│           │   └── AlertControls.tsx
│           └── hooks/
│               └── useAlerts.ts
├── test/
│   ├── core/
│   │   ├── AlertStateMachine.test.ts
│   │   └── AlertManager.test.ts
│   ├── store/
│   │   └── AlertStore.test.ts
│   ├── integration/
│   │   └── NotificationTransformer.test.ts
│   └── api/
│       └── routes.test.ts
├── package.json
├── tsconfig.json
├── jest.config.js
├── .eslintrc.js
├── .prettierrc
├── LICENSE
└── README.md
```

## 8. Deployment

### 8.1 Prerequisites

- **Node.js 22+** (required for built-in SQLite via `node:sqlite`)
- Signal K server must be started with `--experimental-sqlite` flag until `node:sqlite` stabilizes

### 8.2 Installation

Standard Signal K plugin installation:
- Via Signal K Appstore (when published)
- Via npm: `npm install signalk-alert-manager`
- Manual: clone to `~/.signalk/node_modules/`

### 8.3 Configuration

Plugin configuration via Signal K Admin UI:
- Escalation timeouts
- Silencing durations
- History retention
- UI preferences

### 8.4 Data Location

- Configuration: `~/.signalk/plugin-config-data/signalk-alert-manager.json`
- Database: `~/.signalk/signalk-alert-manager/alerts.db` (SQLite)

## 9. Future Considerations

### 9.1 NMEA 2000 Integration (v1.1)

- PGN 126983 receive/transmit via canboatjs
- Separate module: `src/n2k/`
- Requires N2K write capability in SK server

### 9.2 OpenBridge Web Components (post March 2026)

- Adopt OpenBridge Lit-based web components when publicly released
- Full component library integration
- Accessibility compliance (WCAG)
- Touch-optimized for marine displays

### 9.3 Alert Aggregation (v2.0)

- Group related alerts
- Aggregate acknowledgment
- Hierarchical alert trees

### 9.4 Transition to Stable node:sqlite

- When `node:sqlite` becomes stable (non-experimental), remove `--experimental-sqlite` flag requirement
