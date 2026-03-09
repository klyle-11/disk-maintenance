"""
Security Headers Middleware - HTTP Security Headers

This module provides middleware for setting security headers on all HTTP
responses to protect against XSS, clickjacking, and other web-based attacks.

Security Headers:
- X-Content-Type-Options: Prevents MIME sniffing
- X-Frame-Options: Prevents clickjacking
- X-XSS-Protection: Enables browser XSS filter
- Content-Security-Policy: Restricts resource loading
- Strict-Transport-Security: Enforces HTTPS (if applicable)
- Referrer-Policy: Controls referrer information leakage
"""

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.base import Request
from starlette.middleware.base import Response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware that adds security headers to all responses.

    Usage:
        from fastapi import FastAPI
        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)

    This middleware adds the following headers:
    - X-Content-Type-Options: nosniff
    - X-Frame-Options: DENY
    - X-XSS-Protection: 1; mode=block
    - Content-Security-Policy: Restricts resource loading
    - Referrer-Policy: no-referrer
    """

    # Security header values
    HEADERS = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'no-referrer',
    }

    # Content Security Policy (CSP)
    # Restrict to localhost only, no external resources
    CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self'; "
        "connect-src 'self' http://localhost:* http://127.0.0.1:*; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "upgrade-insecure-requests;"
    )

    async def dispatch(self, request: Request, call_next):
        """
        Process request and add security headers to response.

        Args:
            request: The incoming request
            call_next: The next middleware/handler in the chain

        Returns:
            Response with security headers added
        """
        response: Response = await call_next(request)

        # Add security headers
        for header, value in self.HEADERS.items():
            response.headers[header] = value

        # Add CSP header
        response.headers['Content-Security-Policy'] = self.CSP

        return response


class StrictTransportSecurityMiddleware(BaseHTTPMiddleware):
    """
    Middleware that adds HSTS header (for HTTPS enforcement).

    NOTE: Only use this if your application is served over HTTPS.
    Using this with HTTP can break your application.

    Usage:
        app.add_middleware(StrictTransportSecurityMiddleware)
    """

    HSTS_HEADER = 'max-age=31536000; includeSubDomains; preload'

    async def dispatch(self, request: Request, call_next):
        """
        Process request and add HSTS header to response.

        Args:
            request: The incoming request
            call_next: The next middleware/handler

        Returns:
            Response with HSTS header
        """
        response: Response = await call_next(request)

        # Only add HSTS if using HTTPS
        if request.url.scheme == 'https':
            response.headers['Strict-Transport-Security'] = self.HSTS_HEADER

        return response


class CustomSecurityHeaders:
    """
    Helper class for setting custom security headers.

    Usage:
        headers = CustomSecurityHeaders()
        headers.apply(response)
    """

    @staticmethod
    def apply(response: Response, headers: dict) -> None:
        """
        Apply custom security headers to a response.

        Args:
            response: The response to modify
            headers: Dictionary of headers to add
        """
        for header, value in headers.items():
            response.headers[header] = value

    @staticmethod
    def get_csp_header(allow_scripts: bool = True) -> str:
        """
        Get a CSP header string.

        Args:
            allow_scripts: Whether to allow inline scripts

        Returns:
            CSP header string
        """
        csp = (
            "default-src 'self'; "
            f"script-src 'self' {'unsafe-inline' 'unsafe-eval' if allow_scripts else ''}; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "font-src 'self'; "
            "connect-src 'self' http://localhost:* http://127.0.0.1:*; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self';"
        )
        return csp


def get_security_middleware() -> SecurityHeadersMiddleware:
    """
    Get the standard security headers middleware.

    Returns:
        SecurityHeadersMiddleware instance
    """
    return SecurityHeadersMiddleware()


# ============================================================================
# FastAPI Integration
# ============================================================================

def add_security_headers(app) -> None:
    """
    Add security headers middleware to a FastAPI application.

    Args:
        app: The FastAPI application instance
    """
    app.add_middleware(SecurityHeadersMiddleware)

    # Only add HSTS if using HTTPS
    # app.add_middleware(StrictTransportSecurityMiddleware)
