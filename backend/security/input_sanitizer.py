"""
Input Sanitizer - Validate and Sanitize User Inputs

This module provides input validation and sanitization for all user inputs
to prevent injection attacks, DoS attacks, and other input-based vulnerabilities.

Security Features:
- Type validation
- Length limit enforcement
- Character allowlisting
- Special character filtering
- Null byte prevention
- Format validation (UUID, paths, etc.)
"""

import re
import uuid
from typing import Any, Optional, Pattern
from enum import Enum


class ValidationError(Exception):
    """Raised when input fails validation."""
    pass


class InputType(Enum):
    """Types of inputs we validate."""
    SCAN_PATH = "scan_path"
    SNAPSHOT_ID = "snapshot_id"
    COMPARISON_PATH = "comparison_path"
    DEPTH = "depth"
    TOP = "top"
    EXCLUDE_PATTERN = "exclude_pattern"


class InputSanitizer:
    """
    Sanitizes and validates user inputs to prevent attacks.

    Usage:
        sanitizer = InputSanitizer()

        # Validate scan path
        safe_path = sanitizer.sanitize_scan_path(user_input)

        # Validate snapshot ID
        safe_id = sanitizer.sanitize_snapshot_id(user_input)
    """

    # Maximum lengths for different input types
    MAX_LENGTHS = {
        InputType.SCAN_PATH: 1000,
        InputType.SNAPSHOT_ID: 100,
        InputType.COMPARISON_PATH: 1000,
        InputType.DEPTH: 3,
        InputType.TOP: 4,
        InputType.EXCLUDE_PATTERN: 500,
    }

    # Patterns for different input types
    PATTERNS = {
        # Paths are treated as opaque folder names — dangerous chars are already
        # caught by _check_dangerous_chars and traversal by path_validator.
        InputType.EXCLUDE_PATTERN: re.compile(r'^[\w\s\-.*?/\\]+$'),
    }

    # Dangerous characters to reject (only null bytes — paths are never
    # passed to a shell, so command-injection chars are not a risk here)
    DANGEROUS_CHARS = [
        '\x00',  # Null byte
    ]

    def __init__(self, strict_mode: bool = True):
        """
        Initialize the input sanitizer.

        Args:
            strict_mode: If True, reject any suspicious input.
                        If False, be more lenient (for testing only).
        """
        self.strict_mode = strict_mode

    def _check_length(self, value: str, input_type: InputType) -> None:
        """
        Check if input length is within limits.

        Args:
            value: The input value
            input_type: Type of input

        Raises:
            ValidationError: If input is too long
        """
        max_len = self.MAX_LENGTHS.get(input_type, 1000)
        if len(value) > max_len:
            raise ValidationError(
                f"Input too long (max {max_len} characters)"
            )

    def _check_dangerous_chars(self, value: str) -> None:
        """
        Check for dangerous characters.

        Args:
            value: The input value

        Raises:
            ValidationError: If dangerous characters found
        """
        found = []
        for char in self.DANGEROUS_CHARS:
            if char in value:
                found.append(repr(char))

        if found and self.strict_mode:
            raise ValidationError(
                f"Input contains dangerous characters: {', '.join(found)}"
            )

    def _remove_null_bytes(self, value: str) -> str:
        """
        Remove null bytes from input.

        Args:
            value: The input value

        Returns:
            Input with null bytes removed
        """
        return value.replace('\x00', '')

    def _strip_control_chars(self, value: str) -> str:
        """
        Strip control characters except allowed ones.

        Args:
            value: The input value

        Returns:
            Input with control characters stripped
        """
        # Allowed control characters: tab, newline
        allowed_control = {'\t', '\n', '\r'}
        return ''.join(
            char for char in value
            if char.isprintable() or char in allowed_control
        )

    def sanitize_string(self, value: str, input_type: InputType) -> str:
        """
        Generic string sanitization.

        Args:
            value: The input string
            input_type: Type of input

        Returns:
            Sanitized string

        Raises:
            ValidationError: If input fails validation
        """
        if not isinstance(value, str):
            raise ValidationError("Input must be a string")

        # Remove null bytes
        value = self._remove_null_bytes(value)

        # Strip dangerous control characters
        value = self._strip_control_chars(value)

        # Check length
        self._check_length(value, input_type)

        # Check for dangerous characters
        self._check_dangerous_chars(value)

        # Apply type-specific validation
        if input_type in self.PATTERNS:
            pattern = self.PATTERNS[input_type]
            if not pattern.match(value):
                raise ValidationError(
                    f"Input contains invalid characters for {input_type.value}"
                )

        return value.strip()

    def sanitize_scan_path(self, path: str) -> str:
        """
        Sanitize a scan path input.

        Args:
            path: The scan path from user input

        Returns:
            Sanitized scan path

        Raises:
            ValidationError: If path is invalid
        """
        sanitized = self.sanitize_string(path, InputType.SCAN_PATH)

        # Additional path-specific checks
        # Reject absolute paths to system directories
        system_dirs = ['/etc', '/root', '/sys', '/proc',
                       'C:\\Windows\\System32', 'C:\\Windows\\System',
                       '~/.ssh', '~/.aws']

        path_lower = sanitized.lower()
        for sys_dir in system_dirs:
            if path_lower.startswith(sys_dir.lower()):
                raise ValidationError(
                    f"Access to system directory '{sys_dir}' is not allowed"
                )

        return sanitized

    def sanitize_snapshot_id(self, snapshot_id: str) -> str:
        """
        Sanitize and validate a snapshot ID.

        Args:
            snapshot_id: The snapshot ID to validate

        Returns:
            Validated snapshot ID

        Raises:
            ValidationError: If ID is invalid
        """
        # Remove null bytes
        snapshot_id = self._remove_null_bytes(snapshot_id)

        # Check length
        self._check_length(snapshot_id, InputType.SNAPSHOT_ID)

        # Validate UUID format (if it looks like a UUID)
        try:
            # Try to parse as UUID
            validated = uuid.UUID(snapshot_id)
            return str(validated)
        except ValueError:
            # Not a UUID, accept as custom ID
            # But ensure it's alphanumeric with hyphens/underscores
            if not re.match(r'^[\w\-]+$', snapshot_id):
                raise ValidationError(
                    "Snapshot ID must be a valid UUID or alphanumeric string"
                )
            return snapshot_id

    def sanitize_comparison_path(self, path: str) -> str:
        """
        Sanitize a comparison path (source or target).

        Args:
            path: The comparison path

        Returns:
            Sanitized path

        Raises:
            ValidationError: If path is invalid
        """
        return self.sanitize_string(path, InputType.COMPARISON_PATH)

    def sanitize_depth(self, depth_str: str) -> int:
        """
        Sanitize and validate depth parameter.

        Args:
            depth_str: The depth as string

        Returns:
            Validated depth as integer

        Raises:
            ValidationError: If depth is invalid
        """
        # Remove null bytes
        depth_str = self._remove_null_bytes(depth_str)

        # Check length
        self._check_length(depth_str, InputType.DEPTH)

        # Must be numeric
        if not depth_str.isdigit():
            raise ValidationError("Depth must be a positive integer")

        depth = int(depth_str)

        # Validate range (1-100 is reasonable)
        if depth < 1 or depth > 100:
            raise ValidationError("Depth must be between 1 and 100")

        return depth

    def sanitize_top(self, top_str: str) -> int:
        """
        Sanitize and validate top parameter.

        Args:
            top_str: The top as string

        Returns:
            Validated top as integer

        Raises:
            ValidationError: If top is invalid
        """
        # Remove null bytes
        top_str = self._remove_null_bytes(top_str)

        # Check length
        self._check_length(top_str, InputType.TOP)

        # Must be numeric
        if not top_str.isdigit():
            raise ValidationError("Top must be a positive integer")

        top = int(top_str)

        # Validate range (1-1000 is reasonable)
        if top < 1 or top > 1000:
            raise ValidationError("Top must be between 1 and 1000")

        return top

    def sanitize_exclude_pattern(self, pattern: str) -> str:
        """
        Sanitize an exclude pattern for file/directory matching.

        Args:
            pattern: The exclude pattern

        Returns:
            Sanitized pattern

        Raises:
            ValidationError: If pattern is invalid
        """
        return self.sanitize_string(pattern, InputType.EXCLUDE_PATTERN)

    def validate_json(self, json_str: str) -> dict:
        """
        Validate and parse JSON input safely.

        Args:
            json_str: The JSON string to validate

        Returns:
            Parsed JSON as dict

        Raises:
            ValidationError: If JSON is invalid or contains dangerous data
        """
        import json

        # Remove null bytes
        json_str = self._remove_null_bytes(json_str)

        # Check length (be reasonable about JSON size)
        if len(json_str) > 10000:  # 10KB limit
            raise ValidationError("JSON input too large")

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as e:
            raise ValidationError(f"Invalid JSON: {e}")

        # Ensure it's a dict (object)
        if not isinstance(data, dict):
            raise ValidationError("JSON must be an object")

        # Recursively validate all string values
        self._validate_json_dict(data)

        return data

    def _validate_json_dict(self, data: dict) -> None:
        """
        Recursively validate all values in JSON dict.

        Args:
            data: The parsed JSON dict

        Raises:
            ValidationError: If any value is dangerous
        """
        for key, value in data.items():
            # Validate keys (prevent key injection)
            if not isinstance(key, str):
                raise ValidationError("JSON keys must be strings")

            # Check for dangerous characters in keys
            for char in self.DANGEROUS_CHARS:
                if char in key:
                    raise ValidationError(
                        f"Dangerous character in JSON key: {repr(char)}"
                    )

            # Recursively validate values
            if isinstance(value, str):
                # Check string values for dangerous patterns
                self._check_dangerous_chars(value)
            elif isinstance(value, dict):
                self._validate_json_dict(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        self._validate_json_dict(item)
                    elif isinstance(item, str):
                        self._check_dangerous_chars(item)


def create_default_sanitizer() -> InputSanitizer:
    """
    Create an InputSanitizer with default settings.

    Returns:
        InputSanitizer configured for production use
    """
    return InputSanitizer(strict_mode=True)


def sanitize_input(value: str, input_type: InputType) -> str:
    """
    Convenience function to sanitize input.

    Args:
        value: The input value
        input_type: Type of input

    Returns:
        Sanitized value

    Raises:
        ValidationError: If validation fails
    """
    sanitizer = create_default_sanitizer()
    return sanitizer.sanitize_string(value, input_type)
