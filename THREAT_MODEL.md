# Disk Intelligence - Threat Model

**Generated**: 2025-03-09
**Version**: 1.0
**Methodology**: STRIDE + PASTA

---

## Executive Summary

This document outlines the threat model for the Disk Intelligence application, a local-only disk analysis tool. The application processes sensitive file system data and must ensure complete data locality and privacy.

**Trust Boundary**: The application runs entirely on the user's local machine with no external network connectivity.

---

## 1. Asset Identification

### 1.1 Primary Assets

| Asset | Sensitivity | Impact if Compromised |
|-------|-------------|----------------------|
| **Scan Results** | HIGH | Exposure of file system structure and metadata |
| **File Paths** | HIGH | Reveals user's file organization and sensitive file locations |
| **Database Contents** | HIGH | Historical scan data, comparison snapshots |
| **Encryption Keys** | CRITICAL | Unauthorized database access |
| **Log Files** | MEDIUM | May contain sensitive file paths |
| **User's File System** | CRITICAL | Direct access via path traversal |

### 1.2 Secondary Assets

| Asset | Sensitivity | Impact |
|-------|-------------|--------|
| Application Code | MEDIUM | Could reveal vulnerabilities |
| Configuration Files | LOW | May contain paths or settings |
| Cache Data | LOW | Temporary scan data |

---

## 2. Threat Agent Analysis

### 2.1 External Threat Agents

| Agent | Motivation | Capability | Likelihood |
|-------|------------|------------|------------|
| **Remote Attacker** | Data theft | LOW | Very Low |
| **Malware** | Data exfiltration | HIGH | Low |
| **Network Sniffer** | Intercept data | LOW | Very Low |

**Analysis**: External threats are minimal due to local-only architecture and no network exposure.

### 2.2 Local Threat Agents

| Agent | Motivation | Capability | Likelihood |
|-------|------------|------------|------------|
| **Local User (Same Account)** | Curiosity/Malicious | HIGH | High |
| **Malicious Local Process** | Data theft | HIGH | Medium |
| **Physical Attacker** | Device theft | MEDIUM | Low |
| **Compromised Dependency** | Data exfiltration | HIGH | Medium |

**Primary Concern**: Local processes with same user privileges accessing the API.

---

## 3. Attack Surface Analysis

### 3.1 Network Attack Surface

```
┌─────────────────────────────────────────┐
│  Local Machine (127.0.0.1/localhost)    │
│                                         │
│  ┌──────────────┐      ┌──────────────┐│
│  │ Frontend     │◄────►│ Backend      ││
│  │ :5173       │       │ :8001       ││
│  └──────────────┘      └──────────────┘│
│         ▲                     ▲         │
│         │                     │         │
└─────────┼─────────────────────┼─────────┘
          │                     │
          │                     │
    ┌─────┴─────┐       ┌──────┴──────┐
    │ Browser   │       │ Local Apps  │
    │ Extension │       │             │
    └───────────┘       └─────────────┘
```

**Exposed Interfaces**:
- Backend API: `http://127.0.0.1:8001/api/*`
- Frontend Dev Server: `http://127.0.0.1:5173`
- Electron Window: `file://` protocol

**Current Vulnerabilities**:
- Wide-open CORS allows any local origin
- No authentication on API
- No rate limiting

### 3.2 File System Attack Surface

**Current Implementation**:
```python
# Backend accepts arbitrary paths
@app.post("/api/scan")
async def start_scan(request: ScanRequest):
    root_path = request.root_path  # ⚠️ No validation
```

**Attackable Paths**:
- User directories: `~/.ssh/`, `~/Documents/`
- System directories: `/etc/`, `C:\Windows\System32\`
- Sensitive files: `~/.aws/credentials`, `~/.ssh/id_rsa`

### 3.3 Data Attack Surface

**Database File**:
- Location: `./disk_intelligence.db`
- Format: SQLite (currently unencrypted)
- Contents: All scan results, file paths, metadata

**Log Files**:
- Location: Application logs
- Contents: File paths, error messages (may contain sensitive data)

---

## 4. STRIDE Threat Analysis

### S - Spoofing

**Threat**: Attacker spoofs legitimate client
- **Likelihood**: Medium
- **Impact**: Medium
- **Mitigation**: No authentication (acceptable for local-only), but bind to 127.0.0.1

### T - Tampering

**Threat**: Attacker modifies scan data or database
- **Likelihood**: Medium
- **Impact**: High
- **Mitigation**: Database encryption, integrity checks

### R - Repudiation

**Threat**: User denies performing scans
- **Likelihood**: Low
- **Impact**: Low
- **Mitigation**: Audit logging (local only)

### I - Information Disclosure

**Threat**: Attacker accesses sensitive file system data
- **Likelihood**: High
- **Impact**: Critical
- **Mitigation**: Path validation, input sanitization, database encryption

### D - Denial of Service

**Threat**: Attacker crashes application via malicious input
- **Likelihood**: Medium
- **Impact**: Medium
- **Mitigation**: Input validation, rate limiting, resource limits

### E - Elevation of Privilege

**Threat**: Attacker gains higher privileges via path traversal
- **Likelihood**: Medium
- **Impact**: High
- **Mitigation**: Path validation, deny-list of sensitive directories

---

## 5. Attack Scenarios

### 5.1 Path Traversal Attack

**Scenario**:
```
1. Attacker (malicious local process) sends request:
   POST /api/scan
   {"root_path": "../../../../../etc"}

2. Backend processes path without validation
3. Backend scans /etc/ directory
4. Returns sensitive system file information
```

**Impact**: HIGH - Exposure of system file structure

**Mitigation Status**: ⚠️ **NOT MITIGATED** - See Phase 2, Step 2.1

### 5.2 Database Exposure

**Scenario**:
```
1. Attacker gains access to user's device
2. Copies disk_intelligence.db
3. Reads all historical scan data
4. Learns file system structure, sensitive locations
```

**Impact**: CRITICAL - Complete privacy violation

**Mitigation Status**: ⚠️ **NOT MITIGATED** - See Phase 2, Step 2.3

### 5.3 Telemetry Data Exfiltration

**Scenario**:
```
1. Compromised dependency in package.json
2. Dependency sends scan data to external server
3. User's file system metadata exposed
4. Privacy violation, cannot be undone
```

**Impact**: CRITICAL - Data exfiltration

**Mitigation Status**: ⚠️ **NOT MITIGATED** - See Phase 3

### 5.4 CORS-Based Data Theft

**Scenario**:
```
1. User visits malicious website
2. Website contains JavaScript:
   fetch('http://localhost:8001/api/snapshots')
3. Browser sends request with user's cookies
4. Malicious site receives all scan data
```

**Impact**: HIGH - Data exfiltration to remote servers

**Mitigation Status**: ⚠️ **NOT MITIGATED** - See Phase 2, Step 2.6

### 5.5 Log File Exposure

**Scenario**:
```
1. Application logs full file paths in plaintext
2. Attacker reads log files
3. Learns sensitive file locations
4. Uses information for targeted attacks
```

**Impact**: MEDIUM - Information disclosure

**Mitigation Status**: ⚠️ **NOT MITIGATED** - See Phase 2, Step 2.4

---

## 6. Security Controls

### 6.1 Preventive Controls

| Control | Status | Implementation Phase |
|---------|--------|---------------------|
| Path Validation | ❌ Not Implemented | Phase 2, Step 2.1 |
| Input Sanitization | ❌ Not Implemented | Phase 2, Step 2.2 |
| Database Encryption | ❌ Not Implemented | Phase 2, Step 2.3 |
| Secure Logging | ❌ Not Implemented | Phase 2, Step 2.4 |
| Security Headers | ❌ Not Implemented | Phase 2, Step 2.5 |
| CORS Lockdown | ❌ Not Implemented | Phase 2, Step 2.6 |
| Dependency Audit | ❌ Not Implemented | Phase 3 |

### 6.2 Detective Controls

| Control | Status | Implementation Phase |
|---------|--------|---------------------|
| Security Testing | ❌ Not Implemented | Phase 5 |
| Network Monitoring | ❌ Not Implemented | Phase 3, Step 3.3 |
| Log Analysis | ❌ Not Implemented | Phase 5 |

### 6.3 Corrective Controls

| Control | Status | Implementation Phase |
|---------|--------|---------------------|
| Incident Response Plan | ❌ Not Implemented | Documentation |
| Database Recovery | ❌ Not Implemented | Phase 2, Step 2.3 |
| Key Rotation | ❌ Not Implemented | Phase 7 |

---

## 7. Risk Assessment

### 7.1 Risk Matrix

| Threat | Likelihood | Impact | Risk Level | Priority |
|--------|-----------|--------|------------|----------|
| Path Traversal | High | Critical | **HIGH** | P1 |
| Database Exposure | Medium | Critical | **HIGH** | P1 |
| Telemetry Exfiltration | Medium | Critical | **HIGH** | P1 |
| CORS Data Theft | High | High | **HIGH** | P1 |
| Log File Exposure | High | Medium | **MEDIUM** | P2 |
| DoS via Malicious Input | Medium | Medium | **MEDIUM** | P2 |
| Compromised Dependency | Low | Critical | **MEDIUM** | P2 |

### 7.2 Risk Acceptance Criteria

**Accepted Risks**:
- None for CRITICAL/ HIGH severity
- Medium risks may be accepted with proper documentation

**Unacceptable Risks**:
- Any CRITICAL severity risk
- Any HIGH severity risk
- Data exfiltration risk
- Privacy violation risk

---

## 8. Security Requirements

### 8.1 Functional Requirements

| ID | Requirement | Priority |
|----|------------|----------|
| SR-001 | No external network calls | CRITICAL |
| SR-002 | All file paths validated | CRITICAL |
| SR-003 | Database encrypted at rest | CRITICAL |
| SR-004 | Logs contain no sensitive data | HIGH |
| SR-005 | All dependencies audited for telemetry | CRITICAL |
| SR-006 | CORS locked to localhost | CRITICAL |
| SR-007 | Input sanitization on all endpoints | CRITICAL |
| SR-008 | Security headers configured | HIGH |
| SR-009 | Rate limiting on API endpoints | MEDIUM |
| SR-010 | Path traversal protection | CRITICAL |

### 8.2 Non-Functional Requirements

| ID | Requirement | Target | Priority |
|----|------------|--------|----------|
| SNFR-001 | Encryption overhead | < 100ms | HIGH |
| SNFR-002 | Security test coverage | 100% | CRITICAL |
| SNFR-003 | Zero external calls | Verified | CRITICAL |
| SNFR-004 | Dependency scan frequency | Daily | HIGH |
| SNFR-005 | SAST scan blocking | Yes | CRITICAL |

---

## 9. Trust Boundaries

### 9.1 User Boundary

```
┌─────────────────────────────────────────────┐
│             User's Laptop                   │
│                                             │
│  ┌──────────────┐                           │
│  │ User Account │                           │
│  │              │                           │
│  │  ┌────────┐  │   ┌──────────────────┐   │
│  │  │ App    │  │   │ File System      │   │
│  │  │        │◄─┼──►│                  │   │
│  │  └────────┘  │   └──────────────────┘   │
│  │             │                           │
│  └──────────────┘                           │
│                                             │
│  ⚠️  Same-privilege threat: Any app with   │
│       same user privileges can access API  │
└─────────────────────────────────────────────┘
```

### 9.2 Data Boundary

```
User's Laptop (Trusted Zone)
    ↓
Application (Semi-Trusted)
    ↓
Database (Encrypted - Trusted)
    ↓
File System (Untrusted - User Controlled)
```

---

## 10. Recommended Mitigations

### 10.1 Immediate (Phase 1-2)

1. **Implement Path Validation**
   - Library: Custom `PathValidator` class
   - Method: Allowlist of permitted roots
   - Testing: Path traversal unit tests

2. **Database Encryption**
   - Technology: SQLCipher
   - Key Derivation: PBKDF2 (256-bit key, 100k iterations)
   - Testing: Encryption/decryption unit tests

3. **CORS Lockdown**
   - Action: Restrict to localhost origins only
   - Testing: Integration tests verify no external origins

4. **Input Sanitization**
   - Library: Custom `InputSanitizer` class
   - Scope: All API endpoints
   - Testing: Fuzzing tests for malicious input

### 10.2 Short-term (Phase 3-4)

5. **Dependency Audit**
   - Tool: pip-audit, npm audit, manual review
   - Action: Disable all telemetry features
   - Verification: Network monitoring

6. **Secure Logging**
   - Implementation: Custom redacting logger
   - Scope: All application logs
   - Testing: Verify no sensitive data in logs

7. **Security Headers**
   - Headers: CSP, X-Frame-Options, X-Content-Type-Options
   - Testing: Header validation tests

### 10.3 Long-term (Phase 5-7)

8. **Security Testing Framework**
   - Coverage: 100% of security code
   - Types: Unit, Integration, E2E, Performance

9. **CI/CD Security Gates**
   - Blocking: SAST, DAST, dependency scans
   - Frequency: Every PR, daily dependency scans

10. **Documentation**
    - Docs: SECURITY.md, PRIVACY.md
    - Guides: Secure usage, developer security

---

## 11. Residual Risk Assessment

### After All Mitigations

| Threat | Likelihood | Impact | Residual Risk |
|--------|-----------|--------|---------------|
| Path Traversal | Very Low | Medium | **LOW** ✅ |
| Database Exposure | Very Low | Medium | **LOW** ✅ |
| Telemetry Exfiltration | Very Low | Critical | **LOW** ✅ |
| CORS Data Theft | Very Low | Medium | **LOW** ✅ |
| Log File Exposure | Low | Low | **LOW** ✅ |

### Residual Risk Acceptance

**Overall Residual Risk**: **LOW** ✅

All HIGH and CRITICAL risks will be reduced to LOW or VERY LOW through the implementation of security controls in this plan.

---

## 12. Threat Model Review

### Review Schedule

- **Initial Review**: Upon completion of Phase 1
- **Post-Implementation**: After Phase 7 completion
- **Periodic**: Every 6 months or after major changes
- **Trigger**: After any security incident

### Review Process

1. Re-identify assets
2. Re-assess threats
3. Evaluate existing controls
4. Identify new threats
5. Update mitigation strategies
6. Re-calculate risk levels

---

## 13. Assumptions

### 13.1 Environmental Assumptions

- Application runs on user's local machine
- No network connectivity except localhost
- User has administrative privileges for their machine
- Operating system provides basic security (user accounts, file permissions)

### 13.2 Threat Agent Assumptions

- Primary threat: Local processes with same user privileges
- Secondary threat: Compromised dependencies
- Remote threats: Minimal (localhost-only architecture)

### 13.3 Control Assumptions

- User will not share encryption keys
- User will keep application updated
- User will review security documentation
- Operating system security patches are applied

---

## 14. Dependencies & References

### 14.1 Methodologies Used

- **STRIDE**: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege
- **PASTA**: Process for Attack Simulation and Threat Analysis
- **OWASP ASVS**: Application Security Verification Standard
- **CWE Top 25**: Most Dangerous Software Errors

### 14.2 Reference Materials

- OWASP Top 10 2021
- CWE-25 Top 25 Most Dangerous Software Errors
- NIST Cybersecurity Framework
- ISO 27001 (Information Security)

---

## 15. Conclusion

The Disk Intelligence application, while designed as a local-only tool, has significant security vulnerabilities that must be addressed. The primary threats are:

1. **Path Traversal** - Can expose sensitive system files
2. **Database Exposure** - All scan data currently unencrypted
3. **Telemetry Exfiltration** - Potential via compromised dependencies
4. **CORS Misconfiguration** - Allows data theft by local websites

By implementing the security controls outlined in this plan, all HIGH and CRITICAL risks can be reduced to LOW or VERY LOW, making the application safe for distribution to other users.

**Next Steps**:
- Proceed with Phase 1, Step 1.2: Security Requirements Definition
- Begin implementing security controls in Phase 2

---

**Document Owner**: Security Team
**Review Date**: 2025-03-09
**Next Review**: After Phase 7 completion
**Version**: 1.0
