# Disk Intelligence - Security & Privacy Audit Plan

## Overview

Complete security and privacy hardening for the Disk Intelligence application to ensure:
- **100% data locality** - No data leaves the user's machine
- **Zero telemetry** - No analytics, crash reporting, or phone-home functionality
- **Secure local operations** - Protected against local privilege escalation and data leaks
- **Production-ready** - Safe for others to deploy on their own laptops

## Current Security Assessment

### Identified Vulnerabilities

| Severity | Category | Issue | Impact |
|----------|----------|-------|--------|
| **HIGH** | Input Validation | No path traversal sanitization | Attackers can read arbitrary files |
| **HIGH** | CORS | Wide-open CORS (`allow_origins=["*"]`) | Any local webpage can access the API |
| **MEDIUM** | Data Storage | SQLite database unencrypted | Physical access exposes all scan data |
| **MEDIUM** | Logging | File paths logged in plaintext | Log files contain sensitive paths |
| **MEDIUM** | Dependencies | unaudited for telemetry | Potential data exfiltration via deps |
| **LOW** | Headers | No security headers configured | Increased attack surface |
| **LOW** | Rate Limiting | No rate limiting on API endpoints | DoS vulnerability |

### Privacy Risks

| Risk | Source | Mitigation |
|------|--------|------------|
| **Telemetry** | npm packages (React, Vite, etc.) | Audit and disable telemetry |
| **Telemetry** | Python packages (FastAPI, Uvicorn) | Audit and disable telemetry |
| **Data Leakage** | Error messages exposing paths | Sanitize all error outputs |
| **Data Leakage** | Stack traces in logs | Redact sensitive information |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    User's Laptop                             │
│                                                               │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  Electron App    │         │   Python Backend │          │
│  │  (React/Vite)    │◄────────┤    (FastAPI)     │          │
│  │  Port: 5173      │         │    Port: 8001    │          │
│  └──────────────────┘         └──────────────────┘          │
│                                       │                      │
│                                       ▼                      │
│                              ┌──────────────────┐            │
│                              │  SQLite Database │            │
│                              │  (Encrypted)     │            │
│                              └──────────────────┘            │
│                                                               │
│  Security Layer:                                              │
│  - No external network calls (localhost only)                │
│  - Database encryption at rest                               │
│  - Input validation & sanitization                           │
│  - Secure logging (redacted)                                 │
│  - CORS locked to localhost                                  │
│  - No telemetry from dependencies                            │
└─────────────────────────────────────────────────────────────┘
```

## Non-Functional Requirements

### Security
- **Zero External Network Calls**: All communication must be localhost only
- **Data Encryption at Rest**: SQLite database encrypted with SQLCipher
- **Input Validation**: All user inputs validated and sanitized
- **Path Traversal Protection**: Prevent access to files outside scanned directories
- **Secure Logging**: No sensitive data in logs (paths, filenames redacted)
- **No Telemetry**: All dependency telemetry disabled
- **Security Headers**: Content-Security-Policy, X-Frame-Options, etc.

### Privacy
- **Data Locality**: 100% of data stays on user's machine
- **No Analytics**: Zero tracking, analytics, or crash reporting
- **No Error Reporting**: Errors logged locally only
- **No Auto-Updates**: Manual update process only
- **User Control**: User explicitly controls what gets scanned

### Performance
- **Encryption Overhead**: < 100ms for database operations
- **Scan Performance**: No degradation from security measures
- **Memory Usage**: < 500MB for typical scans

### Maintainability
- **Security Tests**: All security measures tested automatically
- **Audit Trail**: All security decisions documented
- **Dependency Updates**: Automated vulnerability scanning

### Testability
- **Security Test Coverage**: 100% of security code paths tested
- **Integration Tests**: Validate no external network calls
- **E2E Tests**: Verify encryption/decryption workflows

## Tech Stack

| Layer | Technology | Security Justification |
|-------|-----------|------------------------|
| **Backend** | FastAPI 0.104+ | Type-safe, auto-validation, no known telemetry |
| **Backend** | Uvicorn | ASGI server, configurable logging, telemetry disabled |
| **Backend** | SQLCipher | Encrypted SQLite database |
| **Backend** | Pydantic | Input validation, type safety |
| **Frontend** | React 19 | Local rendering, no telemetry (when configured) |
| **Frontend** | Vite | Fast builds, disable HMR telemetry |
| **Frontend** | Electron | Desktop packaging, disable auto-updater |
| **Unit Testing** | pytest (Python) | Security-focused testing |
| **Unit Testing** | Vitest (TypeScript) | Fast, no telemetry |
| **Integration Testing** | Testcontainers | Isolated test environments |
| **E2E Testing** | Playwright | Local browser automation |
| **Security Scanning** | Bandit | Python SAST |
| **Security Scanning** | Semgrep | Multi-language SAST |
| **Security Scanning** | pip-audit | Python dependency scanning |
| **Security Scanning** | npm audit | JavaScript dependency scanning |
| **Secret Scanning** | GitLeaks | Prevent committed secrets |
| **CI/CD** | Azure DevOps | Automated security scans, blocking on vulnerabilities |
| **IaC** | N/A | Not applicable (local-only app) |
| **Logging** | Python logging + structlog | Redacted, structured logging |
| **Monitoring** | Local logs only | No external monitoring |

## Project Structure

```
disk-maintenance/
├── .azure-devops/
│   ├── pipelines/
│   │   ├── security-scan.yml        # CI/CD security pipeline
│   │   └── test.yml                 # Test pipeline
│   └── templates/
│       └── security-approval.yml     # Security gate template
├── backend/
│   ├── main.py                       # FastAPI app (to be secured)
│   ├── database.py                   # Database models (to be encrypted)
│   ├── security/
│   │   ├── __init__.py
│   │   ├── path_validator.py         # Path traversal protection
│   │   ├── input_sanitizer.py        # Input sanitization
│   │   ├── encryption.py             # Database encryption wrapper
│   │   └── secure_logger.py          # Redacted logging
│   ├── tests/
│   │   ├── test_security.py          # Security unit tests
│   │   ├── test_path_traversal.py    # Path traversal tests
│   │   └── test_encryption.py        # Encryption tests
│   └── requirements.txt              # Python deps (audited)
├── frontend/
│   ├── src/
│   │   ├── security/
│   │   │   ├── audit-deps.js         # Dependency telemetry audit
│   │   │   �   └── whitelist.txt      # Allowed dependencies
│   │   ├── api.ts                    # API client (localhost only)
│   │   └── App.tsx                   # Main app
│   ├── tests/
│   │   ├── security/
│   │   │   ├── test-local-only.spec.ts  # Verify no external calls
│   │   │   └── test-csp.spec.ts         # CSP header tests
│   │   └── e2e/
│   │       └── security.spec.ts       # E2E security tests
│   └── package.json                  # Node deps (audited)
├── scripts/
│   ├── audit-dependencies.py         # Dependency telemetry auditor
│   ├── generate-csp-report.html      # CSP compliance report
│   └── verify-local-only.sh          # Verify no external calls
├── .gitignore                        # Exclude sensitive files
├── SECURITY.md                       # Security policy (NEW)
├── PRIVACY.md                        # Privacy policy (NEW)
├── SECURITY_AUDIT_CHECKLIST.md       # Audit checklist (NEW)
└── VULNERABILITY_REPORT.md           # Initial vuln report (NEW)
```

## Implementation Phases

### Phase 1: Security Foundation & Threat Model

**Duration**: 1-2 days
**Priority**: CRITICAL

#### Step 1.1: Threat Modeling
- **Files to Create**: `THREAT_MODEL.md`
- **Activities**:
  - Identify assets (scan data, file paths, user files)
  - Identify threats (local attackers, malware, compromised dependencies)
  - Create attack surface diagram
  - Document trust boundaries
- **Security Considerations**:
  - Local attacker with same user privileges
  - Compromised dependencies exfiltrating data
  - Path traversal to sensitive files
- **Deliverables**: Threat model document, risk assessment matrix

#### Step 1.2: Security Requirements Definition
- **Files to Create**: `SECURITY_REQUIREMENTS.md`
- **Requirements**:
  - SR-001: No external network calls
  - SR-002: All file paths validated
  - SR-003: Database encrypted at rest
  - SR-004: Logs contain no sensitive data
  - SR-005: All dependencies audited for telemetry
  - SR-006: CORS locked to localhost
  - SR-007: Input sanitization on all endpoints
  - SR-008: Security headers configured

#### Step 1.3: Security Testing Framework Setup
- **Files to Create**:
  - `backend/tests/conftest.py` - Pytest fixtures
  - `frontend/tests/security/setup.ts` - Test setup
  - `.azure-devops/pipelines/security-scan.yml`
- **Commands**:
  ```bash
  pip install pytest pytest-cov bandit
  npm install -D vitest @playwright/test
  ```
- **Tools**:
  - Bandit for Python SAST
  - Semgrep for custom security rules
  - Custom test runners for security validation

### Phase 2: Backend Security Hardening

**Duration**: 3-4 days
**Priority**: CRITICAL

#### Step 2.1: Path Traversal Protection
- **Files to Create**: `backend/security/path_validator.py`
- **Security Pattern**: Defense in Depth
- **Implementation**:
  ```python
  class PathValidator:
      VALID_ROOTS = set()  # Configurable allowed roots

      def validate_path(self, path: str) -> bool:
          """Ensure path doesn't escape allowed directories."""
          resolved = Path(path).resolve()
          return any(
              resolved.is_relative_to(Path(root).resolve())
              for root in self.VALID_ROOTS
          )

      def sanitize_path(self, path: str) -> str:
          """Remove dangerous path components."""
          # Remove ../, ~/, and absolute paths
          # Normalize path separators
          pass
  ```
- **Testing**: Unit tests for path traversal attempts (../../../etc/passwd)
- **Clean Code**: Single Responsibility - only validates paths

#### Step 2.2: Input Sanitization Layer
- **Files to Create**: `backend/security/input_sanitizer.py`
- **Security Pattern**: Input Validation Framework
- **Implementation**:
  ```python
  class InputSanitizer:
      def sanitize_scan_path(self, path: str) -> str:
          """Validate and sanitize user-provided scan path."""
          # 1. Validate type (string)
          # 2. Check length limits
          # 3. Remove null bytes
          # 4. Validate against allowlist
          # 5. Return safe path or raise ValueError
          pass

      def sanitize_snapshot_id(self, id: str) -> str:
          """Validate snapshot ID format."""
          # UUID format validation
          pass
  ```
- **Architecture**: Business Logic Layer
- **Testing**: Comprehensive fuzzing tests

#### Step 2.3: Database Encryption
- **Files to Create**: `backend/security/encryption.py`
- **Security Pattern**: Encryption at Rest
- **Implementation**:
  ```python
  from pysqlcipher3 import dbapi2 as sqlite

  class EncryptedDatabase:
      def __init__(self, db_path: str, encryption_key: bytes):
          """Initialize encrypted SQLite database."""
          # Derive key from user password/system key
          # Set PRAGMA key for SQLCipher
          pass

      def _derive_key(self, password: str) -> bytes:
          """Derive encryption key using PBKDF2."""
          # Use 256-bit key, 100,000 iterations
          pass
  ```
- **Clean Code**: Dependency Inversion - abstract database interface
- **Security**: PBKDF2 for key derivation, 256-bit AES
- **Performance**: Benchmark encryption overhead

#### Step 2.4: Secure Logging
- **Files to Create**: `backend/security/secure_logger.py`
- **Security Pattern**: Data Redaction
- **Implementation**:
  ```python
  import re
  from pathlib import Path

  class SecureLogger:
      PATH_PATTERN = re.compile(r'[A-Z]:\\[^ ]+|/[^ ]+')

      def redact_path(self, path: str) -> str:
          """Redact sensitive information from paths."""
          # Replace username, show drive letter only
          # C:\Users\john\Documents → C:\Users\***\Documents
          pass

      def redact_error(self, error: str) -> str:
          """Redact sensitive data from error messages."""
          # Remove file paths, stack traces
          pass
  ```
- **Testing**: Verify no paths in log output

#### Step 2.5: Security Headers Configuration
- **Files to Create**: `backend/security/headers.py`
- **Implementation**:
  ```python
  from fastapi import FastAPI
  from starlette.middleware.base import BaseHTTPMiddleware

  class SecurityHeadersMiddleware(BaseHTTPMiddleware):
      async def dispatch(self, request, call_next):
          response = await call_next(request)
          response.headers['X-Content-Type-Options'] = 'nosniff'
          response.headers['X-Frame-Options'] = 'DENY'
          response.headers['X-XSS-Protection'] = '1; mode=block'
          response.headers['Content-Security-Policy'] = (
              "default-src 'self'; "
              "connect-src 'self'; "
              "script-src 'self'; "
              "style-src 'self' 'unsafe-inline';"
          )
          return response
  ```
- **Security**: Prevent XSS, clickjacking, MIME sniffing

#### Step 2.6: CORS Lockdown
- **Files to Modify**: `backend/main.py`
- **Current**: `allow_origins=["*"]`
- **Fixed**:
  ```python
  app.add_middleware(
      CORSMiddleware,
      allow_origins=[
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:8001",
          "http://127.0.0.1:8001"
      ],
      allow_credentials=True,
      allow_methods=["GET", "POST", "PUT", "DELETE"],
      allow_headers=["Content-Type"],
  )
  ```

### Phase 3: Dependency Audit & Telemetry Elimination

**Duration**: 2-3 days
**Priority**: CRITICAL

#### Step 3.1: Python Dependency Audit
- **Files to Create**:
  - `scripts/audit-python-deps.py`
  - `backend/TELEMETRY_AUDIT.md`
- **Commands**:
  ```bash
  pip install pip-audit safety
  pip-audit --desc
  safety check --json
  ```
- **Process**:
  1. List all transitive dependencies
  2. Research each for telemetry features
  3. Document configuration to disable telemetry
  4. Test with network monitor to verify no external calls
- **Deliverables**: Audit report, telemetry disable guide

#### Step 3.2: Node.js Dependency Audit
- **Files to Create**:
  - `scripts/audit-node-deps.js`
  - `frontend/TELEMETRY_AUDIT.md`
- **Commands**:
  ```bash
  npm install -g npm-audit-resolutions
  npm audit --production
  npx depcheck
  ```
- **Known Telemetry in Dependencies**:
  - Vite: Disable with `VITE_DISABLE_HOST_CHECK=true`
  - React: No telemetry (when built correctly)
  - Electron: Disable auto-updater
- **Configuration**:
  ```javascript
  // vite.config.ts
  export default {
    server: {
      strictPort: true,
      hmr: false,  // Disable HMR telemetry
      watch: null   // Disable file watching
    }
  }
  ```

#### Step 3.3: Verification Scripts
- **Files to Create**: `scripts/verify-local-only.sh`
- **Implementation**:
  ```bash
  #!/bin/bash
  # Monitor network connections during app startup
  tcpdump -i lo -n -t &
  TCPDUMP_PID=$!

  # Start application
  npm run dev &
  APP_PID=$!

  # Wait for startup
  sleep 5

  # Check for non-localhost connections
  if netstat -an | grep -v '127.0.0.1\|::1\|LISTENING'; then
      echo "SECURITY ALERT: External network detected!"
      exit 1
  fi

  kill $TCPDUMP_PID $APP_PID
  echo "PASS: No external network calls detected"
  ```

### Phase 4: Frontend Security Hardening

**Duration**: 2-3 days
**Priority**: HIGH

#### Step 4.1: Localhost-Only Enforcement
- **Files to Create**: `frontend/src/security/localhost-only.ts`
- **Implementation**:
  ```typescript
  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

  if (!API_BASE_URL) {
      throw new Error('API_BASE_URL must be configured');
  }

  const url = new URL(API_BASE_URL);

  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(
          'SECURITY: API must be localhost only. ' +
          `Current: ${url.hostname}`
      );
  }
  ```
- **Testing**: Unit test verifies error thrown for external URLs

#### Step 4.2: Content Security Policy
- **Files to Create**: `frontend/index.html`
- **Implementation**:
  ```html
  <meta http-equiv="Content-Security-Policy" content="
      default-src 'self';
      script-src 'self' 'unsafe-inline';
      style-src 'self' 'unsafe-inline';
      img-src 'self' data:;
      connect-src 'http://localhost:*';
      font-src 'self';
      object-src 'none';
      base-uri 'self';
      form-action 'self';
  ">
  ```

#### Step 4.3: Electron Security Hardening
- **Files to Modify**: `frontend/electron/main.cjs`
- **Implementation**:
  ```javascript
  app.on('ready', () => {
      // Disable hardware acceleration (reduces attack surface)
      app.disableHardwareAcceleration();

      // Block external navigation
      mainWindow.webContents.on('will-navigate', (event, url) => {
          const parsed = new URL(url);
          if (parsed.protocol !== 'file:' &&
              parsed.hostname !== 'localhost' &&
              parsed.hostname !== '127.0.0.1') {
              event.preventDefault();
          }
      });

      // Set CSP
      mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
          callback({
              responseHeaders: {
                  ...details.responseHeaders,
                  'Content-Security-Policy': ["default-src 'self'; connect-src localhost"]
              }
          });
      });
  });
  ```

### Phase 5: Security Testing Implementation

**Duration**: 4-5 days
**Priority**: CRITICAL

#### Step 5.1: Unit Tests - Security Layer
- **Framework**: pytest (Python), Vitest (TypeScript)
- **Coverage Target**: 100% of security code
- **Test Categories**:
  - Path traversal tests
  - Input sanitization tests
  - Encryption/decryption tests
  - Logging redaction tests
- **Files to Create**:
  - `backend/tests/test_security/test_path_validator.py`
  - `backend/tests/test_security/test_input_sanitizer.py`
  - `backend/tests/test_security/test_encryption.py`
  - `frontend/tests/security/test-path-sanitizer.spec.ts`

**Example Test**:
```python
def test_path_traversal_prevention(path_validator):
    """Test that path traversal attacks are blocked."""
    malicious_paths = [
        "../../../etc/passwd",
        "..\\..\\..\\windows\\system32\\config\\sam",
        "/etc/shadow",
        "C:\\Windows\\System32\\config\\SAM"
    ]

    for path in malicious_paths:
        with pytest.raises(InvalidPathError):
            path_validator.validate_path(path)
```

#### Step 5.2: Integration Tests - Local-Only Verification
- **Framework**: pytest + Testcontainers
- **Tests**:
  - Verify no external network calls during scans
  - Verify database encryption/decryption
  - Verify CORS restrictions
  - Verify security headers
- **Files to Create**:
  - `backend/tests/integration/test_local_only.py`
  - `backend/tests/integration/test_cors.py`

**Example Test**:
```python
def test_scan_localhost_only(mocker):
    """Verify scan endpoint only calls localhost."""
    # Mock requests library
    mock_request = mocker.patch('requests.get')

    # Execute scan
    response = client.post("/api/scan", json={"root_path": "/tmp"})

    # Verify no external calls
    for call in mock_request.call_args_list:
        url = call[0][0]
        assert url.startswith('http://localhost') or \
               url.startswith('http://127.0.0.1')
```

#### Step 5.3: E2E Tests - Security Workflows
- **Framework**: Playwright
- **Test Scenarios**:
  - Attempt to scan system-critical paths (should be blocked)
  - Attempt to access snapshot without authentication (local-only, no auth needed)
  - Verify encrypted database cannot be read without key
  - Verify logs contain no sensitive data
- **Files to Create**:
  - `frontend/tests/e2e/security.spec.ts`

**Example Test**:
```typescript
test('blocks path traversal attempts', async ({ page }) => {
  await page.goto('http://localhost:5173');

  // Attempt to scan with path traversal
  await page.fill('[data-testid="scan-path"]', '../../../etc/passwd');
  await page.click('[data-testid="scan-button"]');

  // Verify error message
  await expect(page.locator('[data-testid="error-message"]'))
      .toContainText('Invalid path');
});
```

#### Step 5.4: Contract Tests - API Security
- **Framework**: OpenAPI Schema Validation
- **Tests**:
  - Validate request/response schemas
  - Verify rate limiting headers
  - Verify security headers present
- **Files to Create**:
  - `backend/tests/contract/test_api_security.py`

#### Step 5.5: Performance Tests - Encryption Overhead
- **Framework**: pytest-benchmark
- **Tests**:
  - Database read/write with encryption
  - Scan performance with security checks
  - Logging redaction performance
- **Files to Create**:
  - `backend/tests/performance/test_encryption_overhead.py`

**Example Test**:
```python
def test_database_read_performance(benchmark):
    """Verify encryption doesn't significantly impact reads."""
    db = EncryptedDatabase(':memory:', b'test-key')

    # Benchmark encrypted read
    result = benchmark(db.get_snapshot, 'test-id')

    # Assert < 100ms overhead
    assert result.duration < 0.1  # seconds
```

#### Step 5.6: Security Scanning Automation
- **Files to Create**: `.azure-devops/pipelines/security-scan.yml`
- **Azure DevOps Pipeline**:
  ```yaml
  trigger:
  - main

  pool:
    vmImage: 'ubuntu-latest'

  steps:
  - task: UsePythonVersion@0
    inputs:
      versionSpec: '3.10'

  - script: |
      pip install bandit safety semgrep
      bandit -r backend/ -f json -o bandit-report.json
      safety check --json --output safety-report.json
      semgrep --config=auto --json --output=semgrep-report.json
    displayName: 'Security Scans'

  - task: PublishTestResults@2
    inputs:
      testResultsFormat: 'JUnit'
      testResultsFiles: '**/*-report.json'
      failTaskOnFailedTests: true
    condition: succeededOrFailed()

  - script: |
      npm install -g npm-audit-resolutions
      npm audit --production --audit-level=high
    displayName: 'Dependency Security Scan'

  - task: CmdLine@2
    inputs:
      script: |
        scripts/verify-local-only.sh
    displayName: 'Verify No External Calls'
  ```

### Phase 6: DevOps Automation (Azure DevOps)

**Duration**: 2 days
**Priority**: HIGH

#### Step 6.1: CI/CD Pipeline - Security Gates
- **Files to Create**:
  - `.azure-devops/pipelines/pull-request.yml`
  - `.azure-devops/pipelines/main.yml`
- **Stages**:
  1. **Lint & Format Check**
     - Black, isort (Python)
     - ESLint, Prettier (TypeScript)
  2. **Unit Tests**
     - pytest with coverage
     - Vitest with coverage
  3. **Security Scans** (BLOCKING)
     - Bandit SAST
     - Semgrep custom rules
     - pip-audit
     - npm audit
  4. **Integration Tests**
     - Local-only verification
     - CORS testing
     - Encryption tests
  5. **E2E Tests**
     - Playwright security scenarios
  6. **Build & Package**
     - Electron app packaging
     - Code signing (optional)
- **Blocking Rules**: Pipeline fails on:
  - Any HIGH/CRITICAL vulnerability
  - Security test failure
  - Coverage < 80%

#### Step 6.2: Automated Dependency Scanning
- **Frequency**: Daily
- **Azure DevOps Pipeline**:
  ```yaml
  schedules:
  - cron: "0 0 * * *"
    displayName: Daily dependency scan
    branches:
      include:
      - main

  steps:
  - script: |
      pip-audit --format json > dependency-report.json
      npm audit --json >> dependency-report.json
    displayName: 'Scan Dependencies'

  - task: PublishBuildArtifacts@1
    inputs:
      artifactName: 'dependency-reports'
      pathToPublish: dependency-report.json
  ```

#### Step 6.3: Secret Scanning
- **Tool**: GitLeaks
- **Azure DevOps Pipeline**:
  ```yaml
  steps:
  - script: |
      pip install gitleaks
      gitleaks detect --source . --report-path gitleaks-report.json
    displayName: 'Secret Scanning'

  - task: PublishBuildArtifacts@1
    condition: failed()
    inputs:
      artifactName: 'gitleaks-report'
  ```

### Phase 7: Documentation & Finalization

**Duration**: 2 days
**Priority**: HIGH

#### Step 7.1: Security Policy
- **Files to Create**: `SECURITY.md`
- **Contents**:
  - Security features overview
  - Reporting vulnerabilities
  - Security best practices for users
  - Encryption details
  - Local-only guarantee

#### Step 7.2: Privacy Policy
- **Files to Create**: `PRIVACY.md`
- **Contents**:
  - Data locality statement
  - No telemetry guarantee
  - What data is stored
  - How data is protected
  - User rights

#### Step 7.3: Security Audit Checklist
- **Files to Create**: `SECURITY_AUDIT_CHECKLIST.md`
- **Checklist**:
  - [ ] All dependencies audited for telemetry
  - [ ] Network monitoring confirms no external calls
  - [ ] Database encryption verified
  - [ ] Path traversal protection tested
  - [ ] Input sanitization tested
  - [ ] Logging redaction tested
  - [ ] Security headers configured
  - [ ] CORS locked to localhost
  - [ ] All security tests passing
  - [ ] CI/CD pipeline blocking on vulnerabilities

#### Step 7.4: User Guide - Secure Usage
- **Files to Create**: `docs/SECURE_USAGE.md`
- **Contents**:
  - How to verify no telemetry
  - How to audit network traffic
  - How to manage encryption keys
  - How to review logs safely
  - How to update securely

#### Step 7.5: Developer Guide - Security
- **Files to Create**: `docs/DEVELOPER_SECURITY.md`
- **Contents**:
  - Security architecture
  - Threat model
  - Adding new features securely
  - Testing security requirements
  - Code review checklist

## Dependency List

### Production Dependencies (Python)

| Package | Version | Purpose | Telemetry Risk | Mitigation |
|---------|---------|---------|----------------|------------|
| fastapi | >=0.104.0 | Web framework | LOW | No known telemetry |
| uvicorn | >=0.24.0 | ASGI server | LOW | Configurable logging |
| pydantic | >=2.5.0 | Validation | NONE | Pure Python |
| sqlalchemy | >=2.0.0 | ORM | NONE | No network calls |
| pysqlcipher3 | >=1.0.0 | Encryption | NONE | Local encryption |
| python-multipart | >=0.0.6 | Form data | NONE | No telemetry |

### Production Dependencies (Node.js)

| Package | Version | Purpose | Telemetry Risk | Mitigation |
|---------|---------|---------|----------------|------------|
| react | ^19.2.0 | UI framework | NONE | No telemetry |
| react-dom | ^19.2.0 | React renderer | NONE | No telemetry |
| electron | ^39.2.7 | Desktop shell | LOW | Disable auto-updater |
| vite | ^7.2.4 | Build tool | LOW | Disable HMR telemetry |

### Development Dependencies (Security)

| Package | Purpose |
|---------|---------|
| bandit | Python SAST |
| safety | Dependency scanning |
| semgrep | Custom security rules |
| pytest | Testing framework |
| pytest-cov | Coverage reporting |
| pytest-benchmark | Performance testing |
| vitest | TypeScript testing |
| @playwright/test | E2E testing |
| gitleaks | Secret scanning |

## Environment Variables

| Variable | Description | Required | Default | Security Note |
|----------|-------------|----------|---------|----------------|
| `VITE_API_BASE_URL` | Backend API URL | Yes | http://127.0.0.1:8001 | Must be localhost |
| `DB_ENCRYPTION_KEY` | Database encryption key | No | (generated) | Store in system keychain |
| `LOG_LEVEL` | Logging verbosity | No | INFO | Don't use DEBUG in production |
| `DISABLE_TELEMETRY` | Explicit telemetry disable | No | true | Always true |
| `CORS_ORIGINS` | Allowed CORS origins | No | localhost list | Never add external origins |

## Success Criteria

- [ ] **Security Tests Passing**: All security tests passing in CI/CD
- [ ] **100% Coverage**: Security code has 100% test coverage
- [ ] **No External Calls**: Network monitoring confirms zero external calls
- [ ] **Encryption Verified**: Database encrypted, verified with recovery test
- [ ] **SAST Clean**: Bandit, Semgrep show no HIGH/CRITICAL issues
- [ ] **Dependency Scan Clean**: pip-audit, npm audit clean
- [ ] **CORS Locked**: Only localhost origins allowed
- [ ] **Headers Configured**: All security headers present
- [ ] **Path Traversal Blocked**: All path traversal attempts fail
- [ ] **Input Sanitized**: All inputs validated and sanitized
- [ ] **Logs Redacted**: No sensitive data in logs
- [ ] **Documentation Complete**: All security docs written
- [ ] **CI/CD Blocking**: Pipeline blocks on security failures
- [ ] **Telemetry Audited**: All dependencies audited, telemetry disabled
- [ ] **E2E Security Tests**: All E2E security scenarios passing

## Security Testing Strategy

### Testing Philosophy
- **Approach**: Security-first TDD (write security tests before implementation)
- **Coverage Target**: 100% for security-critical code
- **Automation**: All security tests automated in CI/CD

### Unit Tests (80% of security tests)
- **Framework**: pytest, Vitest
- **Focus**:
  - Path validation logic
  - Input sanitization
  - Encryption/decryption
  - Log redaction
- **Mocking**: External dependencies mocked
- **Coverage**: 100% of security modules

### Integration Tests (15% of security tests)
- **Framework**: pytest, Testcontainers
- **Focus**:
  - No external network calls
  - CORS enforcement
  - Security headers
  - End-to-end encryption
- **Environment**: Isolated test containers

### E2E Tests (5% of security tests)
- **Framework**: Playwright
- **Focus**:
  - Critical security workflows
  - UI security features
  - User-facing security controls
- **Scenarios**: Path traversal, XSS attempts

### Performance Tests
- **Framework**: pytest-benchmark
- **Focus**:
  - Encryption overhead
  - Security check performance
  - Logging redaction performance

## Security Checklist

For each pull request, verify:

- [ ] No new external dependencies
- [ ] All dependencies audited
- [ ] Security tests added for new code
- [ ] Path traversal tests updated
- [ ] Input validation tests updated
- [ ] No sensitive data in logs
- [ ] Encryption tests updated
- [ ] SAST scans clean
- [ ] Dependency scans clean
- [ ] Code review by security peer

## DevOps Automation Checklist

For CI/CD pipeline:

- [ ] SAST scanning enabled and blocking
- [ ] DAST scanning for API endpoints
- [ ] Dependency scanning automated
- [ ] Secret scanning in PRs
- [ ] Container/image scanning (if applicable)
- [ ] Security test coverage reporting
- [ ] Blocking on HIGH/CRITICAL vulnerabilities
- [ ] Daily dependency scans
- [ ] Automated security reporting

## Monitoring & Alerting

### Local Monitoring Only
- **Metrics**: Security test pass rate
- **Dashboards**: Security scan results
- **Alerting**: NONE (local-only, no external alerts)

### Security Metrics
- Number of vulnerabilities (trend down)
- Test coverage (trend up)
- Security test failures (trend down)
- Time to remediate vulnerabilities

## Backup & Recovery

### Backup Strategy
- **Database Backups**: Manual user-initiated exports
- **Key Backups**: User manages encryption keys
- **Code Backups**: Git repository

### Recovery Procedures
- **Database**: Decrypt and restore from backup
- **Keys**: User must manage key recovery
- **RPO**: User-dependent
- **RTO**: User-dependent

## Appendix A: Known Vulnerabilities - Initial State

### Critical Issues
1. **Wide-open CORS**: Allows any origin to access API
2. **No Path Validation**: Path traversal possible
3. **No Database Encryption**: All data readable
4. **Logging Sensitive Data**: Paths in plaintext logs

### High Issues
1. **No Input Sanitization**: User input not validated
2. **No Security Headers**: Missing CSP, X-Frame-Options
3. **No Rate Limiting**: DoS possible
4. **Dependency Telemetry**: Not audited

### Medium Issues
1. **Error Messages**: May expose sensitive information
2. **No Secrets Management**: Keys in plaintext
3. **No Security Testing**: No automated security tests

## Appendix B: Threat Model

### Assets
- Scan results (file paths, sizes, metadata)
- User file system access
- SQLite database
- Encryption keys

### Threats
- Local attacker with same privileges
- Compromised dependency
- Malware on same machine
- Physical access to device

### Attack Surface
- API endpoints
- File system access
- Database file
- Log files

### Controls
- Path validation
- Input sanitization
- Database encryption
- Secure logging
- Dependency audit
- No external connectivity

## Appendix C: Security Best Practices

### Python Security
- Use type hints (Pydantic)
- Validate all inputs
- Use parameterized queries (SQLAlchemy)
- Avoid `eval()` and `exec()`
- Use `secrets` module for random values
- Avoid hardcoded secrets

### TypeScript Security
- Use strict mode
- Validate all user input
- Sanitize before rendering
- Use `textContent` not `innerHTML`
- Avoid `dangerouslySetInnerHTML`
- Validate API responses

### Database Security
- Encrypt at rest (SQLCipher)
- Use parameterized queries
- Validate before database operations
- Regular backups
- Secure key management

### Network Security
- Localhost only
- No external calls
- CORS restricted
- Security headers
- Rate limiting

## Appendix D: Compliance

This application aims to be compliant with:
- **Data Locality**: 100% local processing
- **Privacy**: No telemetry, no analytics
- **Security**: Industry best practices
- **Transparency**: Open source, auditable

Not applicable (local-only):
- GDPR (no data transfer)
- SOC2 (no cloud services)
- HIPAA (not healthcare data)
- PCI-DSS (no payment data)

---

## Next Steps

To begin implementation, invoke:

```bash
# Execute Phase 1, Step 1: Threat Modeling
/execute-plan phase 1 step 1

# Or proceed sequentially
/next-step
```

---

**Document Version**: 1.0
**Last Updated**: 2025-03-09
**Author**: Security Audit Plan Generator
**Status**: Ready for Implementation
