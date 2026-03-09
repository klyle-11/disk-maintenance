# Node.js Dependency Telemetry Audit Report

Generated: 2026-03-09

## Executive Summary

- Total Dependencies: 18
- Safe Dependencies: 11
- Dependencies with Potential Telemetry: 7

[WARNING] **7 DEPENDENCIES REQUIRE REVIEW**

## Detailed Findings


### @eslint/js (^9.39.1)
**Status**: [OK] SAFE

### @types/node (^24.10.1)
**Status**: [OK] SAFE

### @types/react (^19.2.5)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- index.d.ts: 1 occurrences
- ts5.0\index.d.ts: 1 occurrences

### @types/react-dom (^19.2.3)
**Status**: [OK] SAFE

### @vitejs/plugin-react (^5.1.1)
**Status**: [OK] SAFE

### concurrently (^9.2.1)
**Status**: [OK] SAFE

### cross-env (^10.1.0)
**Status**: [OK] SAFE

### electron (^39.2.7)
**Status**: [OK] SAFE

### electron-builder (^26.4.0)
**Status**: [OK] SAFE

### eslint (^9.39.1)
**Status**: [OK] SAFE

### eslint-plugin-react-hooks (^7.0.1)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- cjs\eslint-plugin-react-hooks.development.js: 1 occurrences
- cjs\eslint-plugin-react-hooks.development.js: 773 occurrences
- cjs\eslint-plugin-react-hooks.production.js: 1 occurrences
- cjs\eslint-plugin-react-hooks.production.js: 773 occurrences

### eslint-plugin-react-refresh (^0.4.24)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- index.js: 1 occurrences

### globals (^16.5.0)
**Status**: [OK] SAFE

### react (^19.2.0)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- cjs\react-jsx-dev-runtime.development.js: 2 occurrences
- cjs\react-jsx-dev-runtime.react-server.development.js: 2 occurrences
- cjs\react-jsx-runtime.development.js: 2 occurrences
- cjs\react-jsx-runtime.react-server.development.js: 2 occurrences
- cjs\react.development.js: 2 occurrences

### react-dom (^19.2.0)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- cjs\react-dom-client.development.js: 1 occurrences
- cjs\react-dom-client.development.js: 4 occurrences
- cjs\react-dom-client.development.js: 2 occurrences
- cjs\react-dom-client.development.js: 2 occurrences
- cjs\react-dom-client.production.js: 1 occurrences

### typescript (~5.9.3)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- lib\lib.dom.d.ts: 36 occurrences
- lib\lib.dom.d.ts: 3 occurrences
- lib\lib.dom.d.ts: 11 occurrences
- lib\lib.dom.d.ts: 4 occurrences
- lib\lib.dom.iterable.d.ts: 4 occurrences

### typescript-eslint (^8.46.4)
**Status**: [OK] SAFE

### vite (^7.2.4)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- dist\client\env.mjs: 8 occurrences
- dist\node\chunks\build2.js: 1 occurrences
- dist\node\chunks\chunk.js: 1 occurrences
- dist\node\chunks\config.js: 6 occurrences
- dist\node\chunks\config.js: 35 occurrences