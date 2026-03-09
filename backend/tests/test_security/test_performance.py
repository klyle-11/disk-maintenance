"""
Performance Tests for Security Operations

These tests verify that security operations add acceptable performance overhead.
"""

import pytest
import os
import tempfile
import time
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.security.path_validator import PathValidator, create_default_validator
from backend.security.input_sanitizer import InputSanitizer
from backend.security.encryption import DatabaseEncryption, EncryptedDatabase
from backend.security.secure_logger import SecureLogger


# ============================================================================
# Performance Benchmarks
# ============================================================================

class TestPerformanceBenchmarks:
    """Test performance of security operations."""

    @pytest.fixture
    def temp_test_dir(self):
        """Create a temporary test directory with files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test files
            for i in range(100):
                test_file = Path(tmpdir) / f"test_{i}.txt"
                test_file.write_text("test content")

            # Create subdirectories
            for i in range(10):
                subdir = Path(tmpdir) / f"subdir_{i}"
                subdir.mkdir()
                (subdir / "file.txt").write_text("subdir content")

            yield tmpdir

    @pytest.fixture
    def validator(self, temp_test_dir):
        """Create a validator for testing."""
        return PathValidator(allowed_roots=[temp_test_dir])

    @pytest.fixture
    def sanitizer(self):
        """Create a sanitizer for testing."""
        return InputSanitizer(strict_mode=True)

    # ------------------------------------------------------------------------
    # Path Validation Performance
    # ------------------------------------------------------------------------

    def test_path_validation_performance(self, validator, temp_test_dir):
        """Test that path validation is fast enough."""
        test_file = Path(temp_test_dir) / "test_0.txt"

        # Benchmark validation
        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            validator.validate(str(test_file))

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Should be very fast (< 1ms per validation)
        assert avg_time < 0.001, f"Path validation too slow: {avg_time:.4f}s per validation"

        print(f"✓ Path validation: {avg_time * 1000:.3f}ms per validation")

    def test_path_validation_with_traversal_performance(self, validator, temp_test_dir):
        """Test validation performance with path traversal attempts."""
        malicious_path = str(Path(temp_test_dir) / ".." / "etc" / "passwd")

        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            try:
                validator.validate(malicious_path)
            except:
                pass  # Expected to fail

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Should still be fast even when rejecting
        assert avg_time < 0.001, f"Traversal validation too slow: {avg_time:.4f}s per validation"

        print(f"✓ Traversal validation: {avg_time * 1000:.3f}ms per validation")

    # ------------------------------------------------------------------------
    # Input Sanitization Performance
    # ------------------------------------------------------------------------

    def test_sanitization_performance(self, sanitizer):
        """Test that input sanitization is fast enough."""
        test_input = "/home/user/documents/test.txt"

        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            sanitizer.sanitize_scan_path(test_input)

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Should be very fast (< 1ms per sanitization)
        assert avg_time < 0.001, f"Sanitization too slow: {avg_time:.4f}s per sanitization"

        print(f"✓ Input sanitization: {avg_time * 1000:.3f}ms per sanitization")

    def test_sanitization_with_dangerous_chars_performance(self, sanitizer):
        """Test sanitization performance with dangerous characters."""
        dangerous_input = "file; rm -rf /"

        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            try:
                sanitizer.sanitize_scan_path(dangerous_input)
            except:
                pass  # Expected to fail

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Should still be fast even when rejecting
        assert avg_time < 0.001, f"Sanitization rejection too slow: {avg_time:.4f}s per sanitization"

        print(f"✓ Sanitization rejection: {avg_time * 1000:.3f}ms per sanitization")

    # ------------------------------------------------------------------------
    # Secure Logging Performance
    # ------------------------------------------------------------------------

    def test_secure_logging_performance(self):
        """Test that secure logging is fast enough."""
        logger = SecureLogger(__name__)

        test_path = "/home/john/documents/test.txt"
        iterations = 1000

        start = time.perf_counter()

        for _ in range(iterations):
            logger.info_scan_start(test_path)

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Should be fast (< 1ms per log call)
        assert avg_time < 0.001, f"Secure logging too slow: {avg_time:.4f}s per log call"

        print(f"✓ Secure logging: {avg_time * 1000:.3f}ms per log call")

    def test_path_redaction_performance(self):
        """Test that path redaction is fast enough."""
        logger = SecureLogger(__name__)

        test_paths = [
            "/home/john/documents/test.txt",
            r"C:\Users\jane\Documents\file.txt",
            "/home/user/.ssh/id_rsa",
            "/home/user/.aws/credentials",
        ]

        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            for path in test_paths:
                logger._redact_path(path)

        end = time.perf_counter()
        total_redactions = iterations * len(test_paths)
        avg_time = (end - start) / total_redactions

        # Should be very fast (< 0.1ms per redaction)
        assert avg_time < 0.0001, f"Path redaction too slow: {avg_time:.6f}s per redaction"

        print(f"✓ Path redaction: {avg_time * 1000000:.3f}μs per redaction")

    # ------------------------------------------------------------------------
    # Encryption Performance
    # ------------------------------------------------------------------------

    def test_key_derivation_performance(self):
        """Test that key derivation is reasonably fast."""
        encryption = DatabaseEncryption()

        password = "test-password-123"
        iterations = 100

        start = time.perf_counter()

        for _ in range(iterations):
            encryption._derive_key(password)

        end = time.perf_counter()
        avg_time = (end - start) / iterations

        # Key derivation is intentionally slow (100k PBKDF2 iterations)
        # Should be around 100-200ms per derivation
        assert avg_time < 0.5, f"Key derivation too slow: {avg_time:.3f}s per derivation"

        print(f"✓ Key derivation: {avg_time * 1000:.1f}ms per derivation")

    @pytest.mark.slow
    def test_encryption_overhead_performance(self):
        """Test encryption overhead for database operations."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            password = "test-password"

            # Create encrypted database
            encryption = DatabaseEncryption()
            encryption.create_encrypted_database(db_path, password)

            # Test write performance
            iterations = 100
            start = time.perf_counter()

            with encryption.get_connection(db_path, password) as conn:
                cursor = conn.cursor()
                for i in range(iterations):
                    cursor.execute(
                        "INSERT INTO _version (version) VALUES (?)",
                        (i,)
                    )
                conn.commit()

            end = time.perf_counter()
            avg_time = (end - start) / iterations

            # Encrypted writes should be reasonable (< 10ms per write)
            assert avg_time < 0.01, f"Encrypted write too slow: {avg_time:.4f}s per write"

            print(f"✓ Encrypted write: {avg_time * 1000:.3f}ms per write")

            # Test read performance
            start = time.perf_counter()

            with encryption.get_connection(db_path, password) as conn:
                cursor = conn.cursor()
                for i in range(iterations):
                    cursor.execute("SELECT version FROM _version")
                    cursor.fetchall()

            end = time.perf_counter()
            avg_time = (end - start) / iterations

            # Encrypted reads should be fast (< 5ms per read)
            assert avg_time < 0.005, f"Encrypted read too slow: {avg_time:.4f}s per read"

            print(f"✓ Encrypted read: {avg_time * 1000:.3f}ms per read")

    # ------------------------------------------------------------------------
    # Scalability Tests
    // ------------------------------------------------------------------------

    def test_validation_scalability(self, validator, temp_test_dir):
        """Test validation performance scales with file count."""
        # Create many files
        file_count = 1000
        for i in range(file_count):
            test_file = Path(temp_test_dir) / f"scale_{i}.txt"
            test_file.write_text("test")

        files = list(Path(temp_test_dir).glob("scale_*.txt"))

        # Benchmark validation of all files
        start = time.perf_counter()

        for file in files:
            validator.validate(str(file))

        end = time.perf_counter()
        total_time = end - start

        # Should scale linearly
        avg_time = total_time / file_count
        assert avg_time < 0.001, f"Scalability issue: {avg_time:.4f}s per file"

        print(f"✓ Validated {file_count} files in {total_time:.3f}s ({avg_time * 1000:.3f}ms per file)")

    def test_sanitization_scalability(self, sanitizer):
        """Test sanitization performance scales with input length."""
        # Test various input lengths
        input_lengths = [10, 100, 1000, 10000]

        for length in input_lengths:
            test_input = "A" * length

            iterations = max(1000 // length, 1)  # Fewer iterations for long inputs
            start = time.perf_counter()

            for _ in range(iterations):
                try:
                    sanitizer.sanitize_scan_path(test_input)
                except:
                    pass  # May be rejected for length

            end = time.perf_counter()
            avg_time = (end - start) / iterations

            # Should scale linearly with length
            # For 10k chars, should still be < 10ms
            max_time = length * 0.000001  # 1μs per character
            assert avg_time < max_time, f"Sanitization doesn't scale well for length {length}"

        print(f"✓ Sanitization scales well with input length")

    # ------------------------------------------------------------------------
    # Memory Usage Tests
    // ------------------------------------------------------------------------

    def test_memory_usage_validation(self, validator, temp_test_dir):
        """Test that validation doesn't leak memory."""
        import tracemalloc

        tracemalloc.start()

        # Take initial snapshot
        snapshot1 = tracemalloc.take_snapshot()

        # Perform many validations
        for i in range(1000):
            test_file = Path(temp_test_dir) / "test_0.txt"
            validator.validate(str(test_file))

        # Take final snapshot
        snapshot2 = tracemalloc.take_snapshot()

        # Calculate memory difference
        top_stats = snapshot2.compare_to(snapshot1, 'lineno')

        # Get total memory increase
        memory_increase = sum(stat.size_diff for stat in top_stats)

        # Should not leak significant memory (< 100KB)
        assert memory_increase < 100000, f"Memory leak detected: {memory_increase / 1024}KB"

        tracemalloc.stop()

        print(f"✓ No memory leaks in validation (increase: {memory_increase / 1024}KB)")

    def test_memory_usage_sanitization(self, sanitizer):
        """Test that sanitization doesn't leak memory."""
        import tracemalloc

        tracemalloc.start()

        # Take initial snapshot
        snapshot1 = tracemalloc.take_snapshot()

        # Perform many sanitizations
        for i in range(1000):
            sanitizer.sanitize_scan_path("/home/user/test.txt")

        # Take final snapshot
        snapshot2 = tracemalloc.take_snapshot()

        # Calculate memory difference
        top_stats = snapshot2.compare_to(snapshot1, 'lineno')

        # Get total memory increase
        memory_increase = sum(stat.size_diff for stat in top_stats)

        # Should not leak significant memory (< 100KB)
        assert memory_increase < 100000, f"Memory leak detected: {memory_increase / 1024}KB"

        tracemalloc.stop()

        print(f"✓ No memory leaks in sanitization (increase: {memory_increase / 1024}KB)")


# ============================================================================
# Performance Comparison Tests
// ============================================================================

class TestPerformanceComparison:
    """Compare performance with and without security controls."""

    def test_validation_vs_no_validation(self, temp_test_dir):
        """Compare performance of validated vs unvalidated paths."""
        validator = PathValidator(allowed_roots=[temp_test_dir])
        test_file = Path(temp_test_dir) / "test.txt"
        test_file.write_text("test")

        # Measure unvalidated path resolution (baseline)
        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            Path(test_file).resolve()

        end = time.perf_counter()
        baseline_time = (end - start) / iterations

        # Measure validated path resolution
        start = time.perf_counter()

        for _ in range(iterations):
            validator.validate(str(test_file))

        end = time.perf_counter()
        validated_time = (end - start) / iterations

        # Validation should add < 1ms overhead
        overhead = validated_time - baseline_time
        assert overhead < 0.001, f"Validation overhead too high: {overhead * 1000:.3f}ms"

        print(f"✓ Validation overhead: {overhead * 1000:.3f}ms per operation")

    def test_sanitized_vs_unsanitized_input(self):
        """Compare performance of sanitized vs unsanitized input."""
        sanitizer = InputSanitizer(strict_mode=True)
        test_input = "/home/user/documents/test.txt"

        # Measure unsanitized processing (baseline)
        iterations = 1000
        start = time.perf_counter()

        for _ in range(iterations):
            _ = test_input.strip().lower()

        end = time.perf_counter()
        baseline_time = (end - start) / iterations

        # Measure sanitized processing
        start = time.perf_counter()

        for _ in range(iterations):
            sanitizer.sanitize_scan_path(test_input)

        end = time.perf_counter()
        sanitized_time = (end - start) / iterations

        # Sanitization should add < 1ms overhead
        overhead = sanitized_time - baseline_time
        assert overhead < 0.001, f"Sanitization overhead too high: {overhead * 1000:.3f}ms"

        print(f"✓ Sanitization overhead: {overhead * 1000:.3f}ms per operation")
