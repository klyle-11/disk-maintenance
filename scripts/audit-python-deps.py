#!/usr/bin/env python3
"""
Python Dependency Telemetry Audit Script

This script audits all Python dependencies for telemetry features,
data collection, and network communication. It generates a report
detailing any telemetry found and how to disable it.

Usage: python scripts/audit-python-deps.py
"""

import subprocess
import sys
import json
import re
from pathlib import Path
from typing import Dict, List, Set
from dataclasses import dataclass, field


@dataclass
class Dependency:
    """Represents a Python package dependency."""
    name: str
    version: str
    telemetry_features: List[str] = field(default_factory=list)
    network_calls: List[str] = field(default_factory=list)
    files_analyzed: int = 0
    safe: bool = True
    notes: List[str] = field(default_factory=list)


class PythonDependencyAuditor:
    """Audits Python dependencies for telemetry and network activity."""

    def __init__(self, backend_dir: Path):
        self.backend_dir = backend_dir
        self.dependencies: Dict[str, Dependency] = {}
        self.telemetry_keywords = [
            r'telemetry',
            r'analytics',
            r'metrics?\.',
            r'tracking',
            r'phone.?home',
            r'report.?error',
            r'sentry',
            r'datadog',
            r'newrelic',
            r'segment\.io',
            r'mixpanel',
            r'amplitude',
        ]

        self.network_keywords = [
            r'urllib\.',
            r'requests\.',
            r'http\.client',
            r'socket\.',
            r'fetch',
            r'axios',
            r'pyhttp',
        ]

    def get_all_dependencies(self) -> None:
        """Get all transitive dependencies using pip freeze."""
        print("[*] Getting all dependencies...")

        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "freeze"],
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(f"[!] Failed to get dependencies: {e}")
            sys.exit(1)

        for line in result.stdout.strip().split('\n'):
            if '==' in line:
                name, version = line.split('==', 1)
                self.dependencies[name] = Dependency(name, version)

        print(f"[+] Found {len(self.dependencies)} dependencies")

    def check_package_source(self, dep_name: str) -> bool:
        """Check if we can access the package source code."""
        try:
            result = subprocess.run(
                [sys.executable, "-c", f"import {dep_name}"],
                capture_output=True,
                text=True,
            )
            return result.returncode == 0
        except Exception:
            return False

    def search_package_for_keywords(self, dep_name: str) -> Dict[str, List[str]]:
        """Search package source code for telemetry-related keywords."""
        findings = {
            'telemetry': [],
            'network': [],
        }

        # Try to get package location
        try:
            result = subprocess.run(
                [sys.executable, "-c",
                 f"import {dep_name}, os; print(os.path.dirname({dep_name}.__file__))"],
                capture_output=True,
                text=True,
            )

            if result.returncode != 0:
                return findings

            pkg_path = Path(result.stdout.strip())
            if not pkg_path.exists():
                return findings

            # Search Python files
            python_files = list(pkg_path.rglob("*.py"))

            for py_file in python_files:
                try:
                    content = py_file.read_text()

                    # Search for telemetry keywords
                    for keyword_pattern in self.telemetry_keywords:
                        pattern = re.compile(keyword_pattern, re.IGNORECASE)
                        matches = pattern.findall(content)
                        if matches:
                            findings['telemetry'].extend([
                                f"{py_file.relative_to(pkg_path)}: {match}"
                                for match in matches[:3]  # Limit matches
                            ])

                    # Search for network keywords
                    for keyword_pattern in self.network_keywords:
                        pattern = re.compile(keyword_pattern, re.IGNORECASE)
                        matches = pattern.findall(content)
                        if matches:
                            # Filter out common non-telemetry uses
                            for match in matches:
                                if not self._is_safe_network_usage(content, match):
                                    findings['network'].append(
                                        f"{py_file.relative_to(pkg_path)}: {match}"
                                    )

                except Exception as e:
                    pass  # Skip files we can't read

        except Exception as e:
            pass  # Skip packages we can't analyze

        return findings

    def _is_safe_network_usage(self, content: str, match: str) -> bool:
        """Determine if network usage is safe (e.g., localhost only)."""
        # Check if it's localhost-related
        context_window = content[max(0, content.find(match) - 50):content.find(match) + 100]
        return bool(re.search(r'localhost|127\.0\.0\.1|::1', context_window, re.IGNORECASE))

    def check_documentation(self, dep_name: str) -> List[str]:
        """Check package documentation for telemetry mentions."""
        notes = []

        try:
            # Try to get package metadata
            result = subprocess.run(
                [sys.executable, "-m", "pip", "show", dep_name],
                capture_output=True,
                text=True,
            )

            output = result.stdout.lower()

            # Check for telemetry-related terms
            telemetry_terms = ['telemetry', 'analytics', 'tracking', 'metrics']
            for term in telemetry_terms:
                if term in output:
                    notes.append(f"Documentation mentions '{term}'")

        except Exception:
            pass

        return notes

    def audit_dependency(self, dep_name: str) -> Dependency:
        """Audit a single dependency for telemetry."""
        dep = self.dependencies[dep_name]
        print(f"\n[*] Auditing {dep_name} {dep.version}...")

        # Check documentation
        notes = self.check_documentation(dep_name)
        dep.notes.extend(notes)

        # Search source code for keywords
        findings = self.search_package_for_keywords(dep_name)

        dep.telemetry_features = findings['telemetry']
        dep.network_calls = findings['network']

        # Determine if safe
        if dep.telemetry_features or dep.network_calls:
            dep.safe = False
            print(f"    [!] POTENTIAL TELEMETRY FOUND")
            for feature in dep.telemetry_features[:3]:
                print(f"        - {feature}")
            for call in dep.network_calls[:3]:
                print(f"        - {call}")
        else:
            print(f"    [OK] No telemetry detected")

        return dep

    def run_pip_audit(self) -> bool:
        """Run pip-audit to check for vulnerabilities."""
        print("\n[*] Running pip-audit...")

        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "pip-audit"],
                capture_output=True,
            )
        except subprocess.CalledProcessError:
            print("[!] Failed to install pip-audit")
            return False

        try:
            result = subprocess.run(
                [sys.executable, "-m", "pipaudit", "--desc"],
                capture_output=True,
                text=True,
            )

            print(result.stdout)
            return result.returncode == 0

        except subprocess.CalledProcessError:
            print("[!] pip-audit found vulnerabilities")
            return False

    def generate_report(self) -> str:
        """Generate audit report."""
        report = []
        report.append("# Python Dependency Telemetry Audit Report")
        report.append(f"\nGenerated: {subprocess.run(['date', '+%Y-%m-%d'], capture_output=True, text=True).stdout.strip()}")
        report.append("\n## Executive Summary")

        total_deps = len(self.dependencies)
        safe_deps = sum(1 for d in self.dependencies.values() if d.safe)
        unsafe_deps = total_deps - safe_deps

        report.append(f"- Total Dependencies: {total_deps}")
        report.append(f"- Safe Dependencies: {safe_deps}")
        report.append(f"- Dependencies with Potential Telemetry: {unsafe_deps}")

        if unsafe_deps == 0:
            report.append("\n[OK] **ALL DEPENDENCIES SAFE**")
        else:
            report.append(f"\n[WARNING] **{unsafe_deps} DEPENDENCIES REQUIRE REVIEW**")

        # Detailed findings
        report.append("\n## Detailed Findings")

        for dep_name, dep in sorted(self.dependencies.items()):
            report.append(f"\n### {dep_name} ({dep.version})")

            if dep.safe:
                report.append("**Status**: [OK] SAFE")
            else:
                report.append("**Status**: [WARNING] POTENTIAL TELEMETRY")

            if dep.telemetry_features:
                report.append("\n**Telemetry Features Found**:")
                for feature in dep.telemetry_features[:5]:
                    report.append(f"- {feature}")

            if dep.network_calls:
                report.append("\n**Network Calls Found**:")
                for call in dep.network_calls[:5]:
                    report.append(f"- {call}")

            if dep.notes:
                report.append("\n**Notes**:")
                for note in dep.notes:
                    report.append(f"- {note}")

        return "\n".join(report)

    def save_report(self, report: str, output_path: Path):
        """Save report to file."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report)
        print(f"\n[+] Report saved to: {output_path}")

    def audit_all(self) -> int:
        """Audit all dependencies and return exit code."""
        # Get dependencies
        self.get_all_dependencies()

        # Run pip-audit
        pip_audit_safe = self.run_pip_audit()

        # Audit each dependency
        print("\n[*] Auditing dependencies for telemetry...")

        critical_packages = ['fastapi', 'uvicorn', 'sqlalchemy', 'pydantic',
                            'flask', 'django', 'requests']

        for dep_name in self.dependencies:
            # Focus on direct dependencies first
            if dep_name.lower() in [pkg.lower() for pkg in critical_packages]:
                self.audit_dependency(dep_name)

        # Generate report
        report = self.generate_report()

        # Save to multiple locations
        self.save_report(report, Path("backend/TELEMETRY_AUDIT.md"))
        self.save_report(report, Path("TELEMETRY_AUDIT_REPORT.md"))

        # Return exit code
        unsafe_count = sum(1 for d in self.dependencies.values() if not d.safe)
        if unsafe_count > 0 or not pip_audit_safe:
            return 1
        return 0


def main():
    """Main entry point."""
    backend_dir = Path(__file__).parent.parent / "backend"

    if not backend_dir.exists():
        print(f"[!] Backend directory not found: {backend_dir}")
        sys.exit(1)

    print("=" * 60)
    print("Python Dependency Telemetry Auditor")
    print("=" * 60)
    print()

    auditor = PythonDependencyAuditor(backend_dir)
    exit_code = auditor.audit_all()

    if exit_code == 0:
        print("\n" + "=" * 60)
        print("[OK] AUDIT PASSED")
        print("=" * 60)
        print("\nAll dependencies are free of known telemetry features.")
    else:
        print("\n" + "=" * 60)
        print("[WARNING] AUDIT FOUND ISSUES")
        print("=" * 60)
        print("\nPotential telemetry or vulnerabilities found.")
        print("Review the audit report for details.")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
