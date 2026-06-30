# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-06-30

### Changed

- **BREAKING:** Renamed the alert `category` field to `group` across the REST API (query parameter and request/response body), the `alerts.*` Signal K delta wire format, and the persisted column (`group_name`). Old `category` field names are silently ignored.
- Repositioned the standards documentation: the alert lifecycle follows the IMO MSC.302(87) / IEC 62923 bridge alert management model; IEC 62682 contributes only the borrowed latching concept.

### Added

- `stateChangedAt` timestamp; the active alert list is ordered most-recent-first by time of last state change, per IEC 62923-1 6.4.2.2.

## [0.1.0] - 2026-02-25

Initial release.

### Added

- Alert lifecycle management (raise, acknowledge, silence, clear) based on IEC 62682 state model
- Four IMO priority levels: emergency, alarm, warning, caution
- Automatic escalation of unacknowledged warnings to alarms
- Time-limited silencing with configurable durations per priority
- Latching support for one-shot event alerts
- Source liveness tracking with stale alert detection
- SQLite persistence for alerts and full audit history (via Node.js 22 `node:sqlite`)
- REST API for all alert operations
- Plugin API (`app.alertManager`) for inter-plugin integration
- Signal K notification interception and automatic transformation to managed alerts
- Delta publishing for real-time WebSocket updates
- Web UI with alert list, alert detail view, alert banner, and audio indicators (Lit web components)
- OpenAPI specification for REST endpoints
- Alert history with query/filter API and configurable retention
