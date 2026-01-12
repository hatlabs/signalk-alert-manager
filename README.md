# signalk-alert-manager

Signal K server plugin for centralized alert management following maritime (IMO) and process industry (IEC) standards.

## Overview

This plugin transforms Signal K's ad-hoc notification model into a structured alert system with:
- Proper lifecycle management (raise, acknowledge, silence, clear)
- IMO-defined alert priorities (Emergency, Alarm, Warning, Caution)
- IEC 62682 state model
- Real-time synchronization across clients
- Persistence across restarts

## Documentation

- [Specification](docs/SPEC.md) - Full technical specification

## Status

**In Development** - This project is currently in the planning and design phase.

## References

- [IMO MSC.302(87)](https://www.imo.org/en/OurWork/Safety/Pages/BridgeAlertManagement.aspx) - Bridge Alert Management Performance Standards
- [IMO A.1021(26)](https://www.imo.org/en/KnowledgeCentre/IndexofIMOResolutions/Pages/A-2009-11.aspx) - Code on Alerts and Indicators
- [OpenBridge Design System](https://www.openbridge.no/)
- [Signal K Specification](https://signalk.org/specification/)
- [GitHub Issue #1857](https://github.com/SignalK/signalk-server/issues/1857) - Data model and lifecycle for alerts

## License

TBD
