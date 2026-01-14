# Implementation Plan: Issue #4 - Signal K Plugin Skeleton

## Overview

Create the basic Signal K plugin structure that loads in the server and provides configuration UI.

## Plugin Interface Requirements

Based on exploration of `@signalk/server-api`, the plugin must:

### Required Properties
- `id: string` - Plugin identifier (`signalk-alert-manager`)
- `name: string` - Display name (`Signal K Alert Manager`)
- `start(config, restart): void` - Initialization handler
- `stop(): void | Promise<void>` - Cleanup handler
- `schema: object` - JSON Schema for configuration

### Optional Properties (for later)
- `registerWithRouter(router)` - REST API endpoints
- `getOpenApi()` - OpenAPI documentation
- `description: string` - Brief description

## Configuration Schema (per SPEC.md Section 10)

```typescript
{
  escalation: {
    warningToAlarm: {
      enabled: boolean,
      timeoutSeconds: number  // default: 300
    }
  },
  silencing: {
    alarmMaxSeconds: number,    // default: 30
    emergencyMaxSeconds: number // default: 10
  },
  sourceTimeout: {
    markStaleAfterSeconds: number  // default: 60
  },
  history: {
    retentionDays: number  // default: 90
  },
  ui: {
    audioEnabled: boolean,  // default: true
    showBanner: boolean     // default: true
  }
}
```

## Module Export Pattern

```typescript
import { Plugin, ServerAPI } from '@signalk/server-api'

export default (app: ServerAPI): Plugin => {
  return {
    id: 'signalk-alert-manager',
    name: 'Signal K Alert Manager',
    start: (config, restart) => { /* ... */ },
    stop: () => { /* ... */ },
    schema: { /* JSON Schema */ }
  }
}
```

## Test Strategy

### Unit Tests (using MockServerAPI)
1. Plugin exports a function
2. Function returns object with required properties
3. Schema validates correctly
4. start() sets plugin status
5. stop() cleans up (returns void or Promise)
6. Configuration defaults are applied

### Integration Tests (manual)
- Plugin loads in Signal K server
- Configuration form renders
- Enable/disable lifecycle works

## Implementation Steps

1. Write tests for plugin interface compliance
2. Create `src/index.ts` with plugin skeleton
3. Implement configuration schema
4. Add start/stop lifecycle with status reporting
5. Verify all tests pass

## Files to Create/Modify

- `src/index.ts` - Plugin entry point (modify existing empty export)
- `test/plugin.test.ts` - Plugin tests (new)

## Configuration Type Definition

Add to `src/types.ts`:
```typescript
export interface PluginConfig {
  escalation?: {
    warningToAlarm?: {
      enabled?: boolean
      timeoutSeconds?: number
    }
  }
  silencing?: {
    alarmMaxSeconds?: number
    emergencyMaxSeconds?: number
  }
  sourceTimeout?: {
    markStaleAfterSeconds?: number
  }
  history?: {
    retentionDays?: number
  }
  ui?: {
    audioEnabled?: boolean
    showBanner?: boolean
  }
}
```
