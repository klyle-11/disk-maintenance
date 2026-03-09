/**
 * Security test setup and utilities for Vitest.
 *
 * This module provides common fixtures, mocks, and utilities
 * for security testing of the frontend application.
 */

import { beforeAll, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// ============================================================================
// Test Configuration
// ============================================================================

beforeAll(() => {
  // Set test environment variables
  process.env.VITE_API_BASE_URL = 'http://127.0.0.1:8001';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ============================================================================
// Security Test Fixtures
// ============================================================================

/**
 * Mock fetch to prevent any external network calls
 */
export const mockFetch = () => {
  global.fetch = vi.fn((url: RequestInfo | URL) => {
    const urlStr = url.toString();

    // Verify it's localhost only
    const parsedUrl = new URL(urlStr);
    const hostname = parsedUrl.hostname;

    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      throw new Error(
        `SECURITY: External call detected to ${hostname} from ${urlStr}`
      );
    }

    // Return mock response
    return Promise.resolve({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    } as Response);
  });
};

/**
 * Monitor all fetch calls to detect external network access
 */
export const monitorFetchCalls = () => {
  const calls: string[] = [];

  const originalFetch = global.fetch;
  global.fetch = vi.fn((url: RequestInfo | URL, options?: RequestInit) => {
    const urlStr = url.toString();
    calls.push(urlStr);
    return originalFetch(url, options);
  });

  return {
    getExternalCalls: () => {
      return calls.filter(call => {
        try {
          const parsed = new URL(call);
          const hostname = parsed.hostname;
          return hostname !== 'localhost' && hostname !== '127.0.0.1';
        } catch {
          return false;
        }
      });
    },
    getAllCalls: () => calls,
    reset: () => calls.splice(0, calls.length),
  };
};

/**
 * Assert that no external network calls were made
 */
export const assertNoExternalCalls = (monitor: ReturnType<typeof monitorFetchCalls>) => {
  const externalCalls = monitor.getExternalCalls();

  if (externalCalls.length > 0) {
    throw new Error(
      `SECURITY VIOLATION: ${externalCalls.length} external calls detected:\n` +
      externalCalls.map(call => `  - ${call}`).join('\n')
    );
  }
};

// ============================================================================
// Malicious Input Test Data
// ============================================================================

export const MALICIOUS_PATHS = [
  // Path traversal attempts
  '../../../etc/passwd',
  '..\\..\\..\\windows\\system32\\config\\sam',
  '/etc/shadow',
  'C:\\Windows\\System32\\config\\SAM',
  './../../../../../../etc/passwd',
  '.../....//etc/passwd',

  // Null byte injection
  'test\x00.txt',
  'scan\x00path',

  // Special shell characters
  '$(whoami)',
  '`id`',
  '; cat /etc/passwd',
  '| ls -la',
  '&& rm -rf /',

  // URL encoded attacks
  '%2e%2e%2fetc%2fpasswd',
  '..%252f..%252fetc%2fpasswd',

  // Unicode attacks
  '\u202e' + 'etc/passwd',  // Right-to-left override
  '\ufeff' + 'scan',  // Zero-width no-break space
  '\u200b' * 100 + 'test',  // Zero-width space

  // Excessively long paths
  'A'.repeat(10000),
];

export const INVALID_SNAPSHOT_IDS = [
  // SQL injection attempts
  "'; DROP TABLE snapshots; --",
  "' OR '1'='1",
  "1' UNION SELECT * FROM snapshots--",

  // XSS attempts
  '<script>alert("xss")</script>',
  'javascript:alert("xss")',
  '" onerror="alert("xss")',

  // Excessively long
  'a'.repeat(10000),

  // Null bytes
  'test\x00id',

  // Special characters
  '../../etc/passwd',
  '../../../',
];

// ============================================================================
// Security Assertions
// ============================================================================

/**
 * Assert that a path was properly sanitized
 */
export const assertPathSanitized = (original: string, sanitized: string) => {
  // Check that dangerous sequences were removed
  expect(sanitized).not.toContain('..');
  expect(sanitized).not.toContain('\\x00');
  expect(sanitized).not.toContain('$(');
  expect(sanitized).not.toContain('`');

  // Check that path is still reasonable
  expect(sanitized.length).toBeGreaterThan(0);
  expect(sanitized.length).toBeLessThanOrEqual(1000);
};

/**
 * Assert that error messages don't leak sensitive information
 */
export const assertErrorMessageSanitized = (errorMessage: string) => {
  // Check for common sensitive patterns
  const sensitivePatterns = [
    /[A-Z]:\\[^ ]+\\[^ ]+/,  // Windows paths
    /\/[^ ]+\/[^ ]+/,  // Unix paths
    /\.ssh/,  // SSH directory
    /\.aws/,  // AWS directory
    /password/i,
    /key/i,
    /token/i,
  ];

  for (const pattern of sensitivePatterns) {
    expect(errorMessage).not.toMatch(pattern);
  }
};

/**
 * Assert that logs are properly redacted
 */
export const assertLogRedacted = (logMessage: string) => {
  // Check for sensitive patterns
  expect(logMessage).not.toMatch(/[A-Z]:\\/[^ ]+\\/[^ ]+/);
  expect(logMessage).not.toMatch(/\/[^ ]+\/[^ ]+/);
  expect(logMessage).not.toMatch(/\.ssh/);
  expect(logMessage).not.toMatch(/\.aws/);

  // Check for redaction indicators
  expect(logMessage).toMatch(/\*\*\*/);  // Should contain *** for redacted data
};

// ============================================================================
// Mock API Responses
// ============================================================================

export const createMockScanResponse = (overrides = {}) => ({
  scanId: 'test-scan-123',
  rootPath: '/tmp/test',
  startedAt: '2025-03-09T10:00:00',
  completedAt: '2025-03-09T10:05:00',
  totalFiles: 150,
  totalFolders: 25,
  totalSizeBytes: 1073741824,
  ...overrides,
});

export const createMockSnapshot = (overrides = {}) => ({
  id: 'snapshot-123',
  scanId: 'scan-123',
  rootPath: '/tmp/test',
  snapshotType: 'scan',
  savedAt: '2025-03-09T10:00:00',
  totalFiles: 150,
  totalSizeBytes: 1073741824,
  findings: [],
  extensions: [],
  ...overrides,
});

// ============================================================================
// CSP Test Helpers
// ============================================================================

/**
 * Verify that Content-Security-Policy is properly set
 */
export const assertCSPHeaders = (headers: Headers) => {
  const csp = headers.get('Content-Security-Policy');
  expect(csp).toBeDefined();

  // Check for critical directives
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("script-src 'self'");

  // Check that unsafe directives are absent
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toMatch(/http[s]?:\/\/[^localhost]/);
};

/**
 * Verify that security headers are present
 */
export const assertSecurityHeaders = (headers: Headers) => {
  expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(headers.get('X-Frame-Options')).toBe('DENY');
  expect(headers.get('X-XSS-Protection')).toContain('mode=block');
};

// ============================================================================
// Performance Thresholds
// ============================================================================

export const PERFORMANCE_THRESHOLDS = {
  encryptionOverhead: 100,  // ms
  pathValidation: 1,  // ms
  inputSanitization: 1,  // ms
  logRedaction: 1,  // ms
};

/**
 * Assert that operation completes within performance threshold
 */
export const assertPerformanceThreshold = (
  operation: string,
  duration: number,
  threshold: number
) => {
  expect(duration).toBeLessThan(threshold);
};

// ============================================================================
// Localhost Enforcement Tests
// ============================================================================

/**
 * Verify that API_BASE_URL is localhost only
 */
export const assertLocalhostOnly = (apiUrl: string) => {
  const url = new URL(apiUrl);

  expect(url.protocol).toBe('http:');
  expect(url.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);

  // Ensure no external hostname
  expect(url.hostname).not.toMatch(/^[^.]+\.[^.]+$/);
};

/**
 * Test that external URLs are blocked
 */
export const assertExternalURLBlocked = (externalUrl: string) => {
  expect(() => {
    assertLocalhostOnly(externalUrl);
  }).toThrow(/SECURITY.*localhost only/i);
};

// ============================================================================
// Telemetry Detection
// ============================================================================

/**
 * Detect if a dependency is making telemetry calls
 */
export const detectTelemetry = () => {
  const telemetryCalls: string[] = [];

  // Intercept fetch
  const originalFetch = global.fetch;
  global.fetch = vi.fn((url: RequestInfo | URL) => {
    const urlStr = url.toString();
    const parsed = new URL(urlStr);

    // Check for known telemetry domains
    const telemetryDomains = [
      'google-analytics.com',
      'analytics.google.com',
      'segment.io',
      'mixpanel.com',
      'amplitude.com',
      'sentry.io',  // If not configured for self-hosted
      'bugsnag.com',
      'rollbar.com',
      'datadoghq.com',
      'newrelic.com',
      'fullstory.com',
      'hotjar.com',
    ];

    if (telemetryDomains.some(domain => parsed.hostname.includes(domain))) {
      telemetryCalls.push(urlStr);
    }

    return originalFetch(url);
  });

  return {
    getTelemetryCalls: () => telemetryCalls,
    hasTelemetry: () => telemetryCalls.length > 0,
    reset: () => telemetryCalls.splice(0, telemetryCalls.length),
  };
};

/**
 * Assert that no telemetry calls were detected
 */
export const assertNoTelemetry = (detector: ReturnType<typeof detectTelemetry>) => {
  const calls = detector.getTelemetryCalls();

  if (calls.length > 0) {
    throw new Error(
      `TELEMETRY DETECTED: ${calls.length} telemetry calls:\n` +
      calls.map(call => `  - ${call}`).join('\n')
    );
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a mock File object for testing
 */
export const createMockFile = (path: string, size: number = 1024): File => {
  const content = new Array(size).fill('x').join('');
  const blob = new Blob([content], { type: 'application/octet-stream' });
  return new File([blob], path);
};

/**
 * Wait for async operation to complete
 */
export const waitFor = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Retry an operation with backoff
 */
export const retry = async <T>(
  fn: () => T,
  maxRetries: number = 3,
  delay: number = 100
): Promise<T> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await waitFor(delay * (i + 1));
    }
  }
  throw new Error('Max retries exceeded');
};

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for security errors
 */
export const isSecurityError = (error: unknown): error is SecurityError => {
  return (
    error instanceof Error &&
    (error as SecurityError).security === true
  );
};

interface SecurityError extends Error {
  security: true;
  code: string;
}

/**
 * Create a security error
 */
export const createSecurityError = (
  message: string,
  code: string
): SecurityError => {
  const error = new Error(message) as SecurityError;
  error.security = true;
  error.code = code;
  return error;
};

// ============================================================================
// Export Defaults
// ============================================================================

export default {
  mockFetch,
  monitorFetchCalls,
  assertNoExternalCalls,
  MALICIOUS_PATHS,
  INVALID_SNAPSHOT_IDS,
  assertPathSanitized,
  assertErrorMessageSanitized,
  assertLogRedacted,
  assertCSPHeaders,
  assertSecurityHeaders,
  assertLocalhostOnly,
  assertExternalURLBlocked,
  detectTelemetry,
  assertNoTelemetry,
  PERFORMANCE_THRESHOLDS,
  createMockScanResponse,
  createMockSnapshot,
};
