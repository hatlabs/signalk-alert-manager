# signalk-alert-manager - Agent Instructions

## Repository Purpose

Signal K server plugin for centralized alert management implementing the IMO bridge alert management model (MSC.302(87) / IEC 62923), with the latching concept borrowed from IEC 62682 (process industries). Transforms Signal K notifications into a structured alert system with lifecycle management, prioritization, and acknowledgment workflows.

## Key Files

| File | Purpose | When to Read |
|------|---------|--------------|
| `docs/SPEC.md` | Full specification with API contracts | Understanding requirements, adding features |
| `docs/ARCHITECTURE.md` | System design and component structure | Major changes, understanding data flow |
| `src/types.ts` | TypeScript type definitions | Working with alert data structures |
| `src/test/MockServerAPI.ts` | Mock Signal K ServerAPI for testing | Writing unit tests |
| `src/api/openApi.json` | OpenAPI specification for REST endpoints | Modifying or documenting API |
| `package.json` | Dependencies, scripts, plugin metadata | Build issues, adding dependencies |

## Project Structure

```
signalk-alert-manager/
├── docs/
│   ├── SPEC.md                     # Full requirements specification
│   ├── ARCHITECTURE.md             # System design
│   └── IMPLEMENTATION_CHECKLIST.md # Implementation tracking
├── src/
│   ├── index.ts                    # Plugin entry point, config schema
│   ├── types.ts                    # TypeScript type definitions
│   ├── core/
│   │   ├── AlertManager.ts         # Main orchestrator
│   │   ├── AlertStateMachine.ts    # Alert lifecycle state transitions (IEC 62923-1 model)
│   │   └── EscalationTimer.ts      # Warning-to-alarm escalation
│   ├── store/
│   │   ├── AlertStore.ts           # SQLite alert persistence via node:sqlite
│   │   └── HistoryStore.ts         # SQLite alert history logging
│   ├── integration/
│   │   ├── NotificationTransformer.ts  # SK notification to alert bridge
│   │   └── DeltaPublisher.ts       # Alert state to SK delta output
│   ├── api/
│   │   ├── routes.ts               # Express REST API handlers
│   │   └── openApi.json            # OpenAPI specification
│   ├── ui/
│   │   ├── index.html              # Vite entry point
│   │   ├── main.ts                 # UI bootstrap
│   │   ├── components/
│   │   │   ├── alert-app.ts        # Root app component (Lit)
│   │   │   ├── alert-list.ts       # Alert list with toolbar
│   │   │   ├── alert-card.ts       # Individual alert display
│   │   │   ├── alert-detail.ts     # Expanded alert view
│   │   │   └── alert-banner.ts     # Embeddable compact banner
│   │   ├── services/
│   │   │   ├── alert-service.ts    # REST + WebSocket client
│   │   │   ├── audio-service.ts    # Browser audio playback
│   │   │   └── simulation-service.ts # Dev simulation controls
│   │   ├── styles/
│   │   │   ├── priority.ts         # Priority color/styling constants
│   │   │   └── icons.ts            # SVG icon definitions
│   │   └── utils/
│   │       └── format.ts           # Formatting helpers
│   └── test/
│       └── MockServerAPI.ts        # Mock ServerAPI for unit tests
├── test/
│   ├── core/                       # AlertManager, StateMachine, Escalation tests
│   ├── store/                      # AlertStore, HistoryStore tests
│   ├── integration/                # NotificationTransformer, DeltaPublisher tests
│   ├── api/                        # REST API route tests, OpenAPI validation
│   ├── ui/                         # Lit component and service tests
│   ├── e2e/                        # End-to-end tests with real SK server
│   └── helpers/                    # Test utilities
├── public/                         # Built UI output (Vite build target)
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.*.ts              # Vitest configs (default, UI, e2e)
```

## Alert Model

### Priority Levels (IMO)

| Priority | Code | Audible | Requires Ack |
|----------|------|---------|--------------|
| Emergency | EA | Continuous | Yes |
| Alarm | A | Yes (silenceable) | Yes |
| Warning | W | Momentary | Yes |
| Caution | C | None | No |

### State Machine (IEC 62923-1)

```
Normal (no alert)
    |
    v condition triggers
Unacknowledged --> RTN-unacknowledged (condition clears before ack)
    |                     |
    v acknowledges        v acknowledges
Acknowledged --------> Normal (condition clears after ack)
```

Unacknowledged and RTN-unacknowledged states flash visual indicators and sound audible alerts per priority.

## Development Commands

```bash
npm run build          # Compile TypeScript
npm run build:ui       # Build UI with Vite (output to public/)
npm run dev:ui         # Vite dev server for UI
npm run test           # Run all Vitest tests
npm run test:ui        # Run UI component tests (happy-dom)
npm run test:e2e       # Run end-to-end tests
npm run lint           # ESLint check
npm run format         # Prettier format
npm run ci             # Full CI check (typecheck + lint + format + test)
```

## Technical Notes

### Technology Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (ESM) |
| Runtime | Node.js 22+ (required for `node:sqlite`) |
| HTTP | Express (provided by SK server) |
| Persistence | SQLite via `node:sqlite` (built-in, experimental) |
| Web UI | [Lit](https://lit.dev/) web components, plain CSS |
| UI Build | Vite |
| Testing | Vitest + happy-dom (for UI tests) |
| Linting | ESLint + Prettier |

### Node.js Requirement

Requires **Node.js 22+** with `--experimental-sqlite` flag for the built-in `node:sqlite` module. This dependency determines the minimum Signal K server version.

### Signal K Integration Points

| Method | Purpose |
|--------|---------|
| `app.registerDeltaInputHandler()` | Intercept incoming notifications |
| `app.handleMessage()` | Publish alert deltas |
| `plugin.registerWithRouter()` | REST API endpoints |
| `app.getDataDirPath()` | SQLite database location |

### API Base Path

REST endpoints live at `/plugins/signalk-alert-manager/`. See `src/api/openApi.json` for the full OpenAPI specification and `docs/SPEC.md` Section 6 for endpoint documentation.

### SK Notification to Alert Mapping

| SK State | Alert Priority |
|----------|----------------|
| `emergency` | Emergency (EA) |
| `alarm` | Alarm (A) |
| `warn`, `warning` | Warning (W) |
| `alert` | Caution (C) |
| `normal`, `nominal` | Clear condition |

### Configuration Schema

Plugin config is defined in `src/index.ts` (`configSchema`). Key settings:

| Group | Setting | Default |
|-------|---------|---------|
| Audio | `minAudiblePriority` | `warning` |
| Silencing | `defaultMaxSilenceSeconds` | 120 |
| Silencing | `emergencyMaxSilenceSeconds` | 30 |
| Escalation | `warningToAlarm.enabled` | true |
| Escalation | `warningToAlarm.timeoutSeconds` | 300 |
| Source Timeout | `markStaleAfterSeconds` | 60 |
| History | `retentionDays` | 90 |
| Dev | `enableSimulation` | false |

## Testing Patterns

### MockServerAPI Usage

The `MockServerAPI` class simulates Signal K server environment:

```typescript
import { MockServerAPI, createTestDelta } from '../src/test/MockServerAPI'

const mockApi = new MockServerAPI()

// Simulate incoming delta
mockApi.pushDelta(createTestDelta({
  context: 'vessels.self',
  updates: [{
    values: [{ path: 'notifications.engine.overTemp', value: { state: 'alarm', message: 'High temp' } }]
  }]
}))

// Verify output
const deltas = mockApi.getCapturedDeltas()
```

### Test Categories

- **State machine tests**: Verify alert lifecycle state transitions
- **API tests**: REST endpoint behavior and OpenAPI spec validation
- **Integration tests**: SK notification transformation, delta publishing
- **Store tests**: SQLite persistence and history queries
- **UI tests**: Lit component rendering and interaction (happy-dom)
- **E2E tests**: Full lifecycle with real Signal K server

## Standards References

- **IMO MSC.302(87)**: Bridge Alert Management Performance Standards
- **IMO A.1021(26)**: Code on Alerts and Indicators
- **IEC 62923-1/-2:2018**: Bridge Alert Management — IEC realization of MSC.302(87); the formal alert state model and alert/indicator lists
- **IEC 62682:2023**: Management of alarm systems for the process industries (source of the borrowed latching concept)
- **OpenBridge**: Maritime UI design guidelines

## Related Repos

- `signalk-server` - Signal K server (plugin host)
- `halos-marine-containers` - Marine container definitions including Signal K
