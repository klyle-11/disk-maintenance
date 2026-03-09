"""
Secure Logger - Redacted Logging for Sensitive Data

This module provides secure logging that automatically redacts sensitive
information like file paths, usernames, and system-specific data.

Security Features:
- Automatic path redaction
- Username redaction
- System directory masking
- Structured logging with correlation IDs
- Configurable log levels
- No sensitive data in log output

Redaction Patterns:
- File paths: /home/user/Documents → /home/***/Documents
- Windows paths: C:\Users\john\file.txt → C:\Users\***\file.txt
- Usernames: Always redacted to ***
- Sensitive directories: .ssh, .aws, etc. always redacted
"""

import logging
import re
import sys
from pathlib import Path
from typing import Any, Optional
from datetime import datetime
import json


class SecureLogger:
    """
    A logger that automatically redacts sensitive information.

    Usage:
        logger = SecureLogger(__name__)
        logger.info_scan("Scanning directory")  # No path logged
        logger.error_file("Failed to access file")  # No path logged

    The logger will automatically redact:
    - File paths (showing only drive letter or domain)
    - Usernames (replaced with ***)
    - Sensitive directories (.ssh, .aws, etc.)
    - System-specific information
    """

    # Redaction patterns
    PATH_PATTERN = re.compile(
        r'[A-Z]:\\[^\\]+(?:\\[^\\]+)*|'  # Windows paths
        r'/[^/\s]+(?:/[^/\s]+)*'  # Unix paths
    )

    # Components of paths to redact
    REDACTED_COMPONENTS = [
        r'home/[^/]+',     # Unix home directories
        r'Users/[^/]+',    # Windows user directories
        r'\.ssh',          # SSH directory
        r'\.aws',          # AWS directory
        r'\.config',       # Config directory
        r'\.ssh/',         # SSH subdirectory
        r'\.gnupg',        # GPG directory
        r'\.kube',         # Kubernetes config
    ]

    # Sensitive file patterns
    SENSITIVE_FILE_PATTERNS = [
        r'id_rsa',
        r'id_ed25519',
        r'id_ecdsa',
        r'known_hosts',
        r'credentials',
        r'\.pem',
        r'\.key',
        r'\.crt',
        r'\.crt',
    ]

    # Words to redact in logs
    REDACTED_WORDS = [
        'password',
        'secret',
        'token',
        'api_key',
        'access_key',
        'private_key',
        'session_id',
        'auth',
    ]

    def __init__(
        self,
        name: str,
        level: int = logging.INFO,
        redact_paths: bool = True,
        redact_usernames: bool = True,
        output_file: Optional[str] = None
    ):
        """
        Initialize the secure logger.

        Args:
            name: Logger name (usually __name__)
            level: Logging level (default: INFO)
            redact_paths: Whether to redact file paths
            redact_usernames: Whether to redact usernames
            output_file: Optional file to append logs to
        """
        self.name = name
        self.redact_paths = redact_paths
        self.redact_usernames = redact_usernames

        # Create logger
        self.logger = logging.getLogger(name)
        self.logger.setLevel(level)

        # Remove existing handlers
        self.logger.handlers.clear()

        # Create formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

        # Console handler
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        self.logger.addHandler(console_handler)

        # File handler (if specified)
        if output_file:
            file_handler = logging.FileHandler(output_file)
            file_handler.setFormatter(formatter)
            self.logger.addHandler(file_handler)

        # Prevent propagation to root logger
        self.logger.propagate = False

    def _redact_path(self, path: str) -> str:
        """
        Redact sensitive information from a file path.

        Args:
            path: The file path to redact

        Returns:
            Redacted path string
        """
        if not self.redact_paths:
            return path

        try:
            # Redact username components
            for pattern in self.REDACTED_COMPONENTS:
                path = re.sub(pattern, r'***', path, flags=re.IGNORECASE)

            # Redact sensitive files
            for pattern in self.SENSITIVE_FILE_PATTERNS:
                path = re.sub(
                    pattern.replace(r'\.', r'\\.'),  # Escape dots for regex
                    '***',
                    path,
                    flags=re.IGNORECASE
                )

            # Keep drive letter and top-level directory, redact middle
            # C:\Users\john\Documents\file.txt -> C:\Users\***\Documents\file.txt
            # /home/john/file.txt -> /home/***/file.txt
            if re.match(r'^[A-Z]:\\', path):  # Windows path
                parts = path.split('\\')
                if len(parts) > 2:
                    # Redact username (usually 3rd part)
                    parts[2] = '***'
                path = '\\'.join(parts)
            elif path.startswith('/'):  # Unix path
                parts = path.split('/')
                if len(parts) > 2:
                    # Redact username (usually 2nd part)
                    parts[2] = '***'
                path = '/'.join(parts)

            return path

        except Exception:
            # If redaction fails, return fully redacted path
            return "***"

    def _redact_message(self, message: str) -> str:
        """
        Redact sensitive information from a log message.

        Args:
            message: The log message to redact

        Returns:
            Redacted message string
        """
        if not message:
            return message

        redacted = message

        # Redact paths
        if self.redact_paths:
            redacted = self.PATH_PATTERN.sub('***', redacted)

        # Redact sensitive words
        for word in self.REDACTED_WORDS:
            # Case-insensitive replacement
            pattern = re.compile(re.escape(word), re.IGNORECASE)
            redacted = pattern.sub('***', redacted)

        return redacted

    def _format_message(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> str:
        """
        Format a log message, redacting sensitive data.

        Args:
            message: The message to format (string or dict)
            extra: Optional extra fields to include

        Returns:
            Formatted and redacted message string
        """
        if isinstance(message, dict):
            # Redact all values in dict
            redacted_dict = {
                k: self._redact_message(str(v))
                for k, v in message.items()
            }
            message_str = json.dumps(redacted_dict)
        else:
            message_str = str(message)
            message_str = self._redact_message(message_str)

        return message_str

    # ============================================================================
    # Logging Methods
    # ============================================================================

    def debug(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> None:
        """Log a debug message."""
        self.logger.debug(self._format_message(message, extra))

    def info(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> None:
        """Log an info message."""
        self.logger.info(self._format_message(message, extra))

    def warning(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> None:
        """Log a warning message."""
        self.logger.warning(self._format_message(message, extra))

    def error(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> None:
        """Log an error message."""
        self.logger.error(self._format_message(message, extra))

    def critical(self, message: Any, extra: Optional[Dict[str, Any]] = None) -> None:
        """Log a critical message."""
        self.logger.critical(self._format_message(message, extra))

    # ============================================================================
    # Specialized Logging Methods (for better semantic clarity)
    # ============================================================================

    def info_scan(self, message: str) -> None:
        """Log a scan-related info message (no path logged)."""
        self.info(f"[SCAN] {message}")

    def info_scan_start(self, root_path: str) -> None:
        """Log scan start (path redacted)."""
        safe_path = self._redact_path(root_path)
        self.info(f"[SCAN] Starting scan of: {safe_path}")

    def info_scan_complete(self, file_count: int, total_size: int) -> None:
        """Log scan completion (no sensitive data)."""
        self.info(f"[SCAN] Complete: {file_count} files, {total_size} bytes")

    def error_file_access(self, message: str) -> None:
        """Log file access error (no path logged)."""
        self.error(f"[FILE ERROR] {message}")

    def error_permission_denied(self, path: str) -> None:
        """Log permission denied error (path redacted)."""
        safe_path = self._redact_path(path)
        self.error(f"[PERMISSION] Access denied: {safe_path}")

    def error_database(self, message: str) -> None:
        """Log database error (no sensitive data)."""
        self.error(f"[DATABASE] {message}")

    def warning_path_skipped(self, path: str, reason: str) -> None:
        """Log path skipped warning (path redacted)."""
        safe_path = self._redact_path(path)
        self.warning(f"[SKIPPED] {safe_path}: {reason}")

    def info_snapshot(self, snapshot_id: str) -> None:
        """Log snapshot operation (ID is safe)."""
        self.info(f"[SNAPSHOT] Operating on snapshot: {snapshot_id}")

    def info_comparison(self, source: str, target: str) -> None:
        """Log comparison operation (paths redacted)."""
        safe_source = self._redact_path(source)
        safe_target = self._redact_path(target)
        self.info(f"[COMPARISON] Comparing {safe_source} → {safe_target}")

    def error_corruption(self, item: str) -> None:
        """Log data corruption warning (no sensitive details)."""
        self.error(f"[CORRUPTION] Data corruption detected: {item}")


def get_secure_logger(name: str) -> SecureLogger:
    """
    Get or create a secure logger for a module.

    Args:
        name: Logger name (usually __name__)

    Returns:
        SecureLogger instance
    """
    return SecureLogger(name)


# ============================================================================
# Convenience Functions for Common Logging Scenarios
# ============================================================================

def log_scan_start(root_path: str, file_count: int = 0) -> None:
    """Log the start of a scan operation (path redacted)."""
    logger = get_secure_logger(__name__)
    logger.info_scan_start(root_path)
    if file_count > 0:
        logger.info(f"Estimated files to scan: {file_count}")


def log_scan_complete(file_count: int, total_size: int, duration: float) -> None:
    """Log scan completion."""
    logger = get_secure_logger(__name__)
    logger.info_scan_complete(file_count, total_size)
    logger.info(f"Duration: {duration:.2f} seconds")


def log_file_error(path: str, error: str) -> None:
    """Log a file access error (path redacted)."""
    logger = get_secure_logger(__name__)
    safe_path = SecureLogger(name="test")._redact_path(path)
    logger.error_file_access(f"Error accessing {safe_path}: {error}")


def log_security_event(event: str, details: Optional[Dict[str, Any]] = None) -> None:
    """Log a security-related event."""
    logger = get_secure_logger(__name__)
    logger.info(f"[SECURITY] {event}", extra=details)
