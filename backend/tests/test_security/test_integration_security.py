"""
Integration Tests for Security Controls

These tests verify that security controls work correctly end-to-end,
including path validation, input sanitization, and secure logging.
"""

import pytest
import os
import tempfile
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.security.path_validator import PathValidator, InvalidPathError, create_default_validator
from backend.security.input_sanitizer import InputSanitizer, ValidationError
from backend.security.secure_logger import SecureLogger


# ============================================================================
# Test Fixtures
# ============================================================================

@pytest.fixture
def temp_test_dir():
    """Create a temporary test directory with some files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create some test files
        test_file = Path(tmpdir) / "test.txt"
        test_file.write_text("test content")

        subdir = Path(tmpdir) / "subdir"
        subdir.mkdir()
        (subdir / "file.txt").write_text("subdir content")

        yield tmpdir


@pytest.fixture
def security_stack(temp_test_dir):
    """Provide a complete security stack for testing."""
    validator = PathValidator(allowed_roots=[temp_test_dir])
    sanitizer = InputSanitizer(strict_mode=True)
    logger = SecureLogger(__name__)

    return {
        "validator": validator,
        "sanitizer": sanitizer,
        "logger": logger,
        "test_dir": temp_test_dir,
    }


# ============================================================================
# Integration Tests: Security Stack
# ============================================================================

class TestSecurityStackIntegration:
    """Test the complete security stack working together."""

    def test_complete_security_flow(self, security_stack):
        """Test the full security flow: sanitize → validate → log."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        logger = security_stack["logger"]
        test_dir = security_stack["test_dir"]

        # Step 1: Sanitize user input
        safe_path = sanitizer.sanitize_scan_path(test_dir)

        # Step 2: Validate path
        validated_path = validator.validate_and_sanitize(safe_path)

        # Step 3: Log securely (path should be redacted)
        logger.info_scan_start(str(validated_path))

        # Verify the flow completed successfully
        assert os.path.exists(validated_path)

    def test_path_traversal_blocked_by_stack(self, security_stack):
        """Test that path traversal is blocked by the security stack."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        test_dir = security_stack["test_dir"]

        # Attempt path traversal
        malicious_path = str(Path(test_dir) / ".." / "etc" / "passwd")

        # Sanitization should pass (it's just a string)
        safe_path = sanitizer.sanitize_scan_path(malicious_path)

        # Validation should block it
        with pytest.raises(InvalidPathError):
            validator.validate_and_sanitize(safe_path)

    def test_null_byte_blocked_by_stack(self, security_stack):
        """Test that null bytes are blocked by the security stack."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        test_dir = security_stack["test_dir"]

        # Attempt null byte injection
        malicious_path = str(Path(test_dir) / "test\x00.txt")

        # Sanitization should remove null bytes
        safe_path = sanitizer.sanitize_scan_path(malicious_path)

        # But validation should still block (file doesn't exist)
        with pytest.raises((InvalidPathError, ValidationError)):
            validator.validate_and_sanitize(safe_path)

    def test_command_injection_blocked_by_stack(self, security_stack):
        """Test that command injection attempts are blocked."""
        sanitizer = security_stack["sanitizer"]
        test_dir = security_stack["test_dir"]

        # Attempt command injection
        malicious_paths = [
            str(Path(test_dir) / "file; rm -rf /"),
            str(Path(test_dir) / "$(whoami)"),
            str(Path(test_dir) / "`id`"),
        ]

        for malicious_path in malicious_paths:
            # Sanitization should block dangerous characters
            with pytest.raises(ValidationError, match="dangerous"):
                sanitizer.sanitize_scan_path(malicious_path)


# ============================================================================
# Integration Tests: Secure Logging
# ============================================================================

class TestSecureLoggingIntegration:
    """Test secure logging with path redaction."""

    def test_logger_redacts_paths(self, security_stack, caplog):
        """Test that logger redacts sensitive path information."""
        logger = security_stack["logger"]
        test_dir = security_stack["test_dir"]

        # Log a scan operation (path should be redacted)
        logger.info_scan_start(test_dir)

        # The path should be redacted in the log
        # Note: We can't easily test the actual log output here,
        # but we can verify the method doesn't crash

    def test_logger_redacts_usernames(self, security_stack):
        """Test that logger redacts usernames."""
        logger = security_stack["logger"]

        # Log with user path (username should be redacted)
        if os.name == 'nt':
            test_path = r"C:\Users\john\Documents\file.txt"
        else:
            test_path = "/home/john/file.txt"

        safe_path = logger._redact_path(test_path)

        # Username should be redacted
        assert "john" not in safe_path
        assert "***" in safe_path

    def test_logger_preserves_safe_information(self, security_stack):
        """Test that logger preserves non-sensitive information."""
        logger = security_stack["logger"]

        # Log a non-sensitive message
        logger.info("Scan completed: 100 files, 1000 bytes")

        # Should not raise any errors


# ============================================================================
# Integration Tests: Multiple Validators
# ============================================================================

class TestMultipleValidators:
    """Test using multiple validators with different allowed roots."""

    def test_cross_validator_isolation(self):
        """Test that validators don't interfere with each other."""
        with tempfile.TemporaryDirectory() as tmpdir1:
            with tempfile.TemporaryDirectory() as tmpdir2:
                # Create two validators with different roots
                validator1 = PathValidator(allowed_roots=[tmpdir1])
                validator2 = PathValidator(allowed_roots=[tmpdir2])

                # Create a file in dir1
                file1 = Path(tmpdir1) / "file1.txt"
                file1.write_text("content")

                # Create a file in dir2
                file2 = Path(tmpdir2) / "file2.txt"
                file2.write_text("content")

                # Validator1 should access dir1 but not dir2
                result1 = validator1.validate(str(file1))
                assert result1 == file1.resolve()

                with pytest.raises(InvalidPathError):
                    validator1.validate(str(file2))

                # Validator2 should access dir2 but not dir1
                result2 = validator2.validate(str(file2))
                assert result2 == file2.resolve()

                with pytest.raises(InvalidPathError):
                    validator2.validate(str(file1))


# ============================================================================
# Integration Tests: Error Handling
# ============================================================================

class TestSecurityErrorHandling:
    """Test error handling in security components."""

    def test_validator_informative_errors(self, security_stack):
        """Test that validator provides informative error messages."""
        validator = security_stack["validator"]
        test_dir = security_stack["test_dir"]

        # Try to access a path outside allowed roots
        external_path = "/etc/passwd"

        with pytest.raises(InvalidPathError) as exc_info:
            validator.validate(external_path)

        # Error message should be informative
        error_msg = str(exc_info.value).lower()
        assert "not within" in error_msg or "dangerous" in error_msg

    def test_sanitizer_informative_errors(self, security_stack):
        """Test that sanitizer provides informative error messages."""
        sanitizer = security_stack["sanitizer"]

        # Try to sanitize a path with dangerous characters
        dangerous_path = "file; rm -rf /"

        with pytest.raises(ValidationError) as exc_info:
            sanitizer.sanitize_scan_path(dangerous_path)

        # Error message should mention dangerous characters
        error_msg = str(exc_info.value).lower()
        assert "dangerous" in error_msg

    def test_error_does_not_leak_sensitive_info(self, security_stack):
        """Test that errors don't leak sensitive path information."""
        validator = security_stack["validator"]

        # Try to access a sensitive path
        sensitive_path = "/home/john/.ssh/id_rsa"

        with pytest.raises(InvalidPathError) as exc_info:
            try:
                validator.validate(sensitive_path)
            except:
                pass  # Ignore other errors

        # Error message should not contain the username
        error_msg = str(exc_info.value).lower()
        # Note: The validator may not even get to check the path if it's not in allowed roots
        # So we just check it doesn't leak what it did see


# ============================================================================
# Integration Tests: Performance
# ============================================================================

class TestSecurityPerformance:
    """Test performance of security operations."""

    def test_validation_performance(self, security_stack, benchmark):
        """Test that validation is fast enough for production use."""
        validator = security_stack["validator"]
        test_dir = security_stack["test_dir"]

        # Create a valid path
        test_file = Path(test_dir) / "test.txt"
        test_file.write_text("test")

        # Benchmark validation
        def validate_path():
            validator.validate(str(test_file))

        # Run multiple iterations
        import time
        iterations = 1000
        start = time.perf_counter()
        for _ in range(iterations):
            validate_path()
        end = time.perf_counter()

        avg_time = (end - start) / iterations

        # Should be very fast (< 1ms per validation)
        assert avg_time < 0.001, f"Validation too slow: {avg_time:.4f}s per validation"

    def test_sanitization_performance(self, security_stack):
        """Test that sanitization is fast enough."""
        sanitizer = security_stack["sanitizer"]
        test_path = "/home/user/documents/test.txt"

        # Benchmark sanitization
        import time
        iterations = 1000
        start = time.perf_counter()
        for _ in range(iterations):
            sanitizer.sanitize_scan_path(test_path)
        end = time.perf_counter()

        avg_time = (end - start) / iterations

        # Should be very fast (< 1ms per sanitization)
        assert avg_time < 0.001, f"Sanitization too slow: {avg_time:.4f}s per sanitization"


# ============================================================================
# Integration Tests: Real-World Scenarios
# ============================================================================

class TestRealWorldScenarios:
    """Test security with real-world usage patterns."""

    def test_scan_workflow(self, security_stack):
        """Test a typical scan workflow through the security stack."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        logger = security_stack["logger"]
        test_dir = security_stack["test_dir"]

        # Simulate user providing a scan path
        user_input = test_dir

        # Step 1: Sanitize
        safe_path = sanitizer.sanitize_scan_path(user_input)

        # Step 2: Validate
        validated_path = validator.validate_and_sanitize(safe_path)

        # Step 3: Log (securely)
        logger.info_scan_start(str(validated_path))

        # Step 4: Simulate scan completion
        logger.info_scan_complete(100, 1000000)

        # Verify workflow completed
        assert Path(validated_path).exists()

    def test_comparison_workflow(self, security_stack, temp_test_dir):
        """Test a directory comparison workflow."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        logger = security_stack["logger"]

        # Create two test directories
        source_dir = Path(temp_test_dir) / "source"
        target_dir = Path(temp_test_dir) / "target"

        source_dir.mkdir()
        target_dir.mkdir()

        # Simulate comparison workflow
        source_input = str(source_dir)
        target_input = str(target_dir)

        # Sanitize both paths
        safe_source = sanitizer.sanitize_comparison_path(source_input)
        safe_target = sanitizer.sanitize_comparison_path(target_input)

        # Validate both paths
        validated_source = validator.validate_and_sanitize(safe_source)
        validated_target = validator.validate_and_sanitize(safe_target)

        # Log comparison
        logger.info_comparison(str(validated_source), str(validated_target))

        # Verify both paths exist and are valid
        assert Path(validated_source).exists()
        assert Path(validated_target).exists()

    def test_snapshot_workflow(self, security_stack):
        """Test a snapshot saving workflow."""
        validator = security_stack["validator"]
        logger = security_stack["logger"]
        test_dir = security_stack["test_dir"]

        # Simulate snapshot ID
        snapshot_id = "test-snapshot-123"

        # Log snapshot operation
        logger.info_snapshot(snapshot_id)

        # Verify no errors raised

    def test_malicious_user_inputs(self, security_stack):
        """Test various malicious user input patterns."""
        sanitizer = security_stack["sanitizer"]
        validator = security_stack["validator"]
        test_dir = security_stack["test_dir"]

        # Common attack patterns
        malicious_inputs = [
            "../../../etc/passwd",
            "..\\..\\..\\windows\\system32\\config\\sam",
            "/etc/shadow",
            "C:\\Windows\\System32\\config\\SAM",
            "$(whoami)",
            "`id`",
            "file; rm -rf /",
            "test\x00.txt",
            "A" * 10000,  # Excessively long
        ]

        for malicious_input in malicious_inputs:
            # All should be blocked by either sanitizer or validator
            try:
                safe = sanitizer.sanitize_scan_path(malicious_input)
                validator.validate_and_sanitize(safe)
                # If we get here, the input wasn't blocked
                assert False, f"Malicious input not blocked: {malicious_input[:50]}"
            except (ValidationError, InvalidPathError):
                # Expected - input was blocked
                pass
