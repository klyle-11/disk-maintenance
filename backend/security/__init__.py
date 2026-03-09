"""
Security Module for Disk Intelligence Backend

This package provides security-critical functionality for:
- Path validation and traversal protection
- Input sanitization
- Database encryption
- Secure logging
- Security headers

All security code follows these principles:
- Security by design (fail closed)
- Defense in depth
- Complete test coverage
- Clear error messages (without exposing sensitive data)
"""

__version__ = "1.0.0"

__all__ = [
    "path_validator",
    "input_sanitizer",
    "encryption",
    "secure_logger",
    "headers",
]
