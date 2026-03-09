"""
Path Validator - Prevent Path Traversal Attacks

This module validates file paths to prevent unauthorized access to files
outside allowed directories. It implements defense-in-depth with multiple
validation layers.

Security Features:
- Allowlist of permitted root directories
- Path normalization and canonicalization
- Symbolic link resolution checking
- Relative path traversal prevention
- Null byte rejection
- Length limit enforcement
"""

import os
from pathlib import Path
from typing import List, Optional, Set
import re


class InvalidPathError(Exception):
    """Raised when a path fails validation."""
    pass


class PathValidator:
    """
    Validates and sanitizes file paths to prevent path traversal attacks.

    Usage:
        validator = PathValidator(allowed_roots=["/tmp", os.path.expanduser("~")])
        validator.validate("/tmp/test.txt")  # OK
        validator.validate("../../../etc/passwd")  # Raises InvalidPathError
    """

    # Patterns that indicate path traversal attempts
    TRAVERSAL_PATTERNS = [
        r'\.\.',          # Parent directory references
        r'~',             # Home directory references
        r'\x00',          # Null bytes
        r'\\|',           # Windows pipe (command injection)
        r';',             # Command separator
        r'&',             # Command separator
        r'\$',            # Command substitution
        r'`',             # Command substitution
        r'\|',            # Pipe
        r'>',             # Output redirection
        r'<',             # Input redirection
    ]

    # Maximum path length (prevent DoS)
    MAX_PATH_LENGTH = 1000

    def __init__(self, allowed_roots: Optional[List[str]] = None):
        """
        Initialize the path validator.

        Args:
            allowed_roots: List of allowed root directories.
                          If None, only allows current directory.
        """
        if allowed_roots is None:
            allowed_roots = [os.getcwd()]

        # Resolve all allowed roots to absolute paths
        self._allowed_roots: Set[Path] = set()
        for root in allowed_roots:
            try:
                resolved = Path(root).resolve()
                if not resolved.exists():
                    raise ValueError(f"Allowed root does not exist: {root}")
                self._allowed_roots.add(resolved)
            except Exception as e:
                raise ValueError(f"Invalid allowed root {root}: {e}")

    def validate(self, path_str: str) -> Path:
        """
        Validate a path string and return a safe Path object.

        Args:
            path_str: The path string to validate

        Returns:
            Resolved, validated Path object

        Raises:
            InvalidPathError: If path fails any validation check
        """
        # Check 1: Length limit (prevent DoS)
        if len(path_str) > self.MAX_PATH_LENGTH:
            raise InvalidPathError(
                f"Path too long (max {self.MAX_PATH_LENGTH} characters)"
            )

        # Check 2: Null bytes (prevent null byte injection)
        if '\x00' in path_str:
            raise InvalidPathError("Null bytes not allowed in paths")

        # Check 3: Traversal patterns (prevent path traversal)
        for pattern in self.TRAVERSAL_PATTERNS:
            if re.search(pattern, path_str):
                raise InvalidPathError(
                    f"Path contains dangerous sequence: {pattern}"
                )

        # Check 4: Resolve path (handle symlinks, relative paths)
        try:
            resolved_path = Path(path_str).resolve()
        except Exception as e:
            raise InvalidPathError(f"Invalid path: {e}")

        # Check 5: Must be within allowed roots
        is_allowed = False
        for allowed_root in self._allowed_roots:
            try:
                resolved_path.relative_to(allowed_root)
                is_allowed = True
                break
            except ValueError:
                # Path is not relative to this root
                continue

        if not is_allowed:
            roots_str = ", ".join(str(r) for r in self._allowed_roots)
            raise InvalidPathError(
                f"Path is not within allowed roots: {roots_str}"
            )

        # Check 6: Path must exist (if checking existing files)
        if not resolved_path.exists():
            raise InvalidPathError(f"Path does not exist: {resolved_path}")

        return resolved_path

    def validate_and_sanitize(self, path_str: str) -> str:
        """
        Validate and sanitize a path string.

        Args:
            path_str: The path string to validate and sanitize

        Returns:
            Sanitized path string (absolute, normalized)

        Raises:
            InvalidPathError: If path fails validation
        """
        validated_path = self.validate(path_str)

        # Return as string, normalized
        return str(validated_path)

    def is_safe_subpath(self, parent_path: Path, child_path: Path) -> bool:
        """
        Check if child_path is safely within parent_path.

        This is useful for validating paths during directory traversal.

        Args:
            parent_path: The parent directory
            child_path: The potential subdirectory

        Returns:
            True if child_path is safely within parent_path
        """
        try:
            child_path.relative_to(parent_path)
            return True
        except ValueError:
            return False

    def get_allowed_roots(self) -> Set[Path]:
        """
        Get the set of allowed root directories.

        Returns:
            Set of allowed root Path objects
        """
        return self._allowed_roots.copy()

    def add_allowed_root(self, root: str) -> None:
        """
        Add a new allowed root directory.

        Args:
            root: Path to add to allowed roots

        Raises:
            ValueError: If root doesn't exist or is invalid
        """
        resolved = Path(root).resolve()
        if not resolved.exists():
            raise ValueError(f"Root does not exist: {root}")
        self._allowed_roots.add(resolved)


def create_default_validator() -> PathValidator:
    """
    Create a PathValidator with sensible default allowed roots.

    Returns:
        PathValidator configured with user home directory
    """
    home_dir = os.path.expanduser("~")
    return PathValidator(allowed_roots=[home_dir])


def is_safe_path(path_str: str, validator: Optional[PathValidator] = None) -> bool:
    """
    Quick check if a path is safe (convenience function).

    Args:
        path_str: The path to check
        validator: Optional validator to use (creates default if None)

    Returns:
        True if path is safe, False otherwise
    """
    if validator is None:
        validator = create_default_validator()

    try:
        validator.validate(path_str)
        return True
    except InvalidPathError:
        return False
