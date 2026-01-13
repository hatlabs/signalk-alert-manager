# Implementation Plan: Issue #5 - ServerAPI Test Harness

## Overview

Create a mock ServerAPI for unit testing plugin components without requiring a real Signal K server.

## Methods to Mock (from ARCHITECTURE.md 5.1)

### Delta Handling
- `handleMessage(pluginId, delta)` - Capture published deltas
- `registerDeltaInputHandler(handler)` - Store handlers, allow delta injection
- `streambundle.getSelfBus(path)` - Return Bacon.js bus
- `streambundle.getSelfStream(path)` - Return Bacon.js stream

### Storage
- `getDataDirPath()` - Return temp directory path
- `savePluginOptions(options, cb)` - Store in memory
- `readPluginOptions()` - Return stored options

### Logging
- `debug(message, ...args)` - Capture debug logs
- `error(message)` - Capture error logs

### Status
- `setPluginStatus(msg)` - Capture status messages
- `setPluginError(msg)` - Capture error status

### Self Identity
- `selfType`, `selfId`, `selfContext` - Configurable test values
- `getSelfPath(path)` - Return configurable test data
- `getPath(path)` - Return configurable test data

## Test Utilities (not part of ServerAPI)

- `reset()` - Clear all captured state between tests
- `pushDelta(delta)` - Inject delta to registered handlers
- `getCapturedDeltas()` - Get deltas sent via handleMessage
- `getCapturedLogs()` - Get debug/error logs
- `setPathValue(path, value)` - Configure mock data

## Dependencies

Need to add `baconjs` as devDependency for stream mocking.

## File Structure

```
src/test/
└── MockServerAPI.ts    # Mock implementation
test/
└── test/
    └── MockServerAPI.test.ts  # Tests for the mock itself
```

## Test Scenarios

1. Mock captures delta messages sent via `handleMessage()`
2. Mock triggers delta input handlers when test pushes deltas
3. Mock provides configurable test data for paths
4. Mock state is resettable between tests
5. Storage methods work correctly
6. Logging methods capture output
