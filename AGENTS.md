# signalk-alert-manager - Agent Instructions

## Repository Purpose

Signal K server plugin for centralized alert management following maritime (IMO MSC.302(87)) and process industry (IEC 62682) standards. Transforms Signal K notifications into a structured alert system with lifecycle management, prioritization, and acknowledgment workflows.

## Key Files

| File | Purpose | When to Read |
|------|---------|--------------|
| `docs/SPEC.md` | Full specification with API contracts | Understanding requirements, adding features |
| `docs/ARCHITECTURE.md` | System design and component structure | Major changes, understanding data flow |
| `src/types.ts` | TypeScript type definitions | Working with alert data structures |
| `src/test/MockServerAPI.ts` | Mock Signal K ServerAPI for testing | Writing unit tests |
| `package.json` | Dependencies, scripts, plugin metadata | Build issues, adding dependencies |

## Project Structure (Planned)

```
signalk-alert-manager/
├── docs/                           # Specifications
│   ├── SPEC.md                     # Full requirements specification
│   └── ARCHITECTURE.md             # System design
├── src/
│   ├── index.ts                    # Plugin entry point
│   ├── types.ts                    # TypeScript type definitions
│   ├── core/                       # Alert lifecycle management
│   │   ├── AlertManager.ts         # Main orchestrator
│   │   └── AlertStateMachine.ts    # State transitions per IEC 62682
│   ├── store/                      # Persistence layer
│   │   ├── AlertStore.ts           # SQLite storage via node:sqlite
│   │   └── HistoryStore.ts         # Alert history logging
│   ├── integration/                # Signal K integration
│   │   ├── NotificationTransformer.ts  # SK notification to alert bridge
│   │   └── DeltaPublisher.ts       # Alert state to SK delta output
│   ├── api/                        # REST API handlers
│   │   └── routes.ts               # Express routes
│   ├── ui/                         # Web UI (TBD)
│   └── test/                       # Test utilities
│       └── MockServerAPI.ts        # Mock ServerAPI for unit tests
└── test/                           # Test files
```

## Alert Model

### Priority Levels (IMO)

| Priority | Code | Audible | Requires Ack |
|----------|------|---------|--------------|
| Emergency | EA | Continuous | Yes |
| Alarm | A | Yes (30s silence) | Yes |
| Warning | W | Momentary | Yes |
| Caution | C | None | No |

### State Machine (IEC 62682)

```
A: Normal (no alert)
    |
    v condition triggers
B: Unacknowledged Active --> D: RTN Unacknowledged (condition clears before ack)
    |                              |
    v operator acknowledges        v operator acknowledges
C: Acknowledged Active ---------> A: Normal (condition clears after ack)
```

States B and D flash visual indicators and sound audible alerts per priority.

## Development Commands

```bash
npm run build          # Compile TypeScript
npm run test           # Run Vitest tests
npm run lint           # ESLint check
npm run format         # Prettier format
npm run ci             # Full CI check (typecheck + lint + format + test)
```

## Technical Notes

### Node.js Requirement

Requires **Node.js 22+** with `--experimental-sqlite` flag for the built-in `node:sqlite` module. This dependency determines the minimum Signal K server version.

### Signal K Integration Points

| Method | Purpose |
|--------|---------|
| `app.registerDeltaInputHandler()` | Intercept incoming notifications |
| `app.handleMessage()` | Publish alert deltas |
| `app.streambundle.getSelfBus()` | Subscribe to path changes |
| `plugin.registerWithRouter()` | REST API endpoints |
| `app.getDataDirPath()` | SQLite database location |

### API Base Path

REST endpoints live at `/plugins/signalk-alert-manager/alerts/*`. See SPEC.md Section 6 for full API documentation.

### SK Notification to Alert Mapping

| SK State | Alert Priority |
|----------|----------------|
| `emergency` | Emergency (EA) |
| `alarm` | Alarm (A) |
| `warn`, `warning` | Warning (W) |
| `alert` | Caution (C) |
| `normal`, `nominal` | Clear condition |

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

- **State machine tests**: Verify IEC 62682 state transitions
- **API tests**: REST endpoint behavior
- **Integration tests**: SK notification transformation
- **Store tests**: Persistence and history queries

## Standards References

- **IMO MSC.302(87)**: Bridge Alert Management Performance Standards
- **IMO A.1021(26)**: Code on Alerts and Indicators
- **IEC 62682:2023**: Management of alarm systems for the process industries
- **OpenBridge**: Maritime UI design guidelines (for future UI work)

## Related Repos

- `signalk-server` - Signal K server (plugin host)
- `halos-marine-containers` - Marine container definitions including Signal K
