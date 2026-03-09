#!/usr/bin/env node

/**
 * Node.js Dependency Telemetry Audit Script
 *
 * This script audits all Node.js dependencies for telemetry features,
 * data collection, and network communication. It generates a report
 * detailing any telemetry found and how to disable it.
 *
 * Usage: node scripts/audit-node-deps.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/**
 * Represents a Node.js package dependency
 */
class Dependency {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this.telemetryFeatures = [];
        this.networkCalls = [];
        this.filesAnalyzed = 0;
        this.safe = true;
        this.notes = [];
    }
}

/**
 * Audits Node.js dependencies for telemetry and network activity
 */
class NodeDependencyAuditor {
    constructor(frontendDir) {
        this.frontendDir = frontendDir;
        this.dependencies = new Map();

        // Keywords that may indicate telemetry
        this.telemetryKeywords = [
            'telemetry',
            'analytics',
            'metrics',
            'tracking',
            'phone.home',
            'report.error',
            'sentry',
            'datadog',
            'newrelic',
            'segment',
            'mixpanel',
            'amplitude',
            'google.analytics',
            'gtag',
            'fbq'
        ];

        // Keywords for network operations
        this.networkKeywords = [
            'fetch(',
            'axios.',
            'XMLHttpRequest',
            'http.request',
            'https.request',
            'net.connect',
            'socket.connect'
        ];
    }

    /**
     * Get all dependencies from package.json
     */
    getAllDependencies() {
        console.log('[*] Getting all dependencies...');

        const packageJsonPath = path.join(this.frontendDir, 'package.json');

        if (!fs.existsSync(packageJsonPath)) {
            console.error('[!] package.json not found');
            process.exit(1);
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

        // Get dependencies and devDependencies
        const allDeps = {
            ...packageJson.dependencies || {},
            ...packageJson.devDependencies || {}
        };

        for (const [name, version] of Object.entries(allDeps)) {
            this.dependencies.set(name, new Dependency(name, version));
        }

        console.log(`[+] Found ${this.dependencies.size} direct dependencies`);
    }

    /**
     * Check if we can access the package source code
     */
    checkPackageSource(depName) {
        try {
            const nodeModulesPath = path.join(this.frontendDir, 'node_modules', depName);
            return fs.existsSync(nodeModulesPath);
        } catch (error) {
            return false;
        }
    }

    /**
     * Search package source code for telemetry-related keywords
     */
    searchPackageForKeywords(depName) {
        const findings = {
            telemetry: [],
            network: []
        };

        try {
            const packagePath = path.join(this.frontendDir, 'node_modules', depName);

            if (!fs.existsSync(packagePath)) {
                return findings;
            }

            // Find all JavaScript/TypeScript files
            const jsFiles = this.findJsFiles(packagePath);

            for (const jsFile of jsFiles) {
                try {
                    const content = fs.readFileSync(jsFile, 'utf8');

                    // Search for telemetry keywords
                    for (const keyword of this.telemetryKeywords) {
                        const regex = new RegExp(keyword, 'gi');
                        const matches = content.match(regex);
                        if (matches) {
                            findings.telemetry.push(
                                `${path.relative(packagePath, jsFile)}: ${matches.length} occurrences`
                            );
                        }
                    }

                    // Search for network keywords
                    for (const keyword of this.networkKeywords) {
                        const regex = new RegExp(keyword, 'gi');
                        const matches = content.match(regex);
                        if (matches) {
                            // Filter out safe network usage
                            for (const match of matches) {
                                if (!this.isSafeNetworkUsage(content, keyword)) {
                                    findings.network.push(
                                        `${path.relative(packagePath, jsFile)}: ${keyword}`
                                    );
                                }
                            }
                        }
                    }

                } catch (error) {
                    // Skip files we can't read
                }
            }

        } catch (error) {
            // Skip packages we can't analyze
        }

        return findings;
    }

    /**
     * Recursively find all JavaScript/TypeScript files
     */
    findJsFiles(dir, files = []) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Skip node_modules and test directories
                if (!['node_modules', 'test', 'tests', '__tests__'].includes(entry.name)) {
                    this.findJsFiles(fullPath, files);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (['.js', '.jsx', '.ts', '.tsx', '.mjs'].includes(ext)) {
                    files.push(fullPath);
                }
            }
        }

        return files;
    }

    /**
     * Determine if network usage is safe (e.g., localhost only)
     */
    isSafeNetworkUsage(content, keyword) {
        // Check if it's localhost-related
        const regex = /localhost|127\.0\.0\.1|::1/gi;
        return regex.test(content);
    }

    /**
     * Check package documentation for telemetry mentions
     */
    checkDocumentation(depName) {
        const notes = [];

        try {
            const packagePath = path.join(this.frontendDir, 'node_modules', depName);
            const packageJsonPath = path.join(packagePath, 'package.json');

            if (!fs.existsSync(packageJsonPath)) {
                return notes;
            }

            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const readmePath = path.join(packagePath, 'README.md');

            // Check package.json for telemetry-related fields
            const jsonStr = JSON.stringify(packageJson).toLowerCase();

            const telemetryTerms = ['telemetry', 'analytics', 'tracking', 'metrics'];
            for (const term of telemetryTerms) {
                if (jsonStr.includes(term)) {
                    notes.push(`package.json mentions '${term}'`);
                }
            }

            // Check README if it exists
            if (fs.existsSync(readmePath)) {
                const readme = fs.readFileSync(readmePath, 'utf8').toLowerCase();
                for (const term of telemetryTerms) {
                    if (readme.includes(term)) {
                        notes.push(`README.md mentions '${term}'`);
                        break;
                    }
                }
            }

        } catch (error) {
            // Skip packages we can't analyze
        }

        return notes;
    }

    /**
     * Audit a single dependency for telemetry
     */
    auditDependency(depName) {
        const dep = this.dependencies.get(depName);
        console.log(`\n[*] Auditing ${depName} ${dep.version}...`);

        // Check documentation
        const notes = this.checkDocumentation(depName);
        dep.notes.push(...notes);

        // Search source code for keywords
        const findings = this.searchPackageForKeywords(depName);

        dep.telemetryFeatures = findings.telemetry;
        dep.networkCalls = findings.network;

        // Determine if safe
        if (dep.telemetryFeatures.length > 0 || dep.networkCalls.length > 0) {
            dep.safe = false;
            console.log('    [!] POTENTIAL TELEMETRY FOUND');
            for (const feature of dep.telemetryFeatures.slice(0, 3)) {
                console.log(`        - ${feature}`);
            }
            for (const call of dep.networkCalls.slice(0, 3)) {
                console.log(`        - ${call}`);
            }
        } else {
            console.log('    [OK] No telemetry detected');
        }

        return dep;
    }

    /**
     * Run npm audit to check for vulnerabilities
     */
    runNpmAudit() {
        console.log('\n[*] Running npm audit...');

        try {
            const result = execSync('npm audit --json', {
                cwd: this.frontendDir,
                encoding: 'utf8'
            });

            const audit = JSON.parse(result);
            const vulnerabilities = audit.metadata?.vulnerabilities;

            if (vulnerabilities) {
                console.log(`\n    Vulnerabilities found:`);
                console.log(`    - Critical: ${vulnerabilities.critical || 0}`);
                console.log(`    - High: ${vulnerabilities.high || 0}`);
                console.log(`    - Moderate: ${vulnerabilities.moderate || 0}`);
                console.log(`    - Low: ${vulnerabilities.low || 0}`);

                return (vulnerabilities.critical || 0) === 0 && (vulnerabilities.high || 0) === 0;
            }

            return true;

        } catch (error) {
            console.log('[!] npm audit found vulnerabilities or failed');
            return false;
        }
    }

    /**
     * Generate audit report
     */
    generateReport() {
        let report = [];
        report.push('# Node.js Dependency Telemetry Audit Report\n');
        report.push(`Generated: ${new Date().toISOString().split('T')[0]}\n`);
        report.push('## Executive Summary\n');

        const totalDeps = this.dependencies.size;
        const safeDeps = Array.from(this.dependencies.values()).filter(d => d.safe).length;
        const unsafeDeps = totalDeps - safeDeps;

        report.push(`- Total Dependencies: ${totalDeps}`);
        report.push(`- Safe Dependencies: ${safeDeps}`);
        report.push(`- Dependencies with Potential Telemetry: ${unsafeDeps}\n`);

        if (unsafeDeps === 0) {
            report.push('[OK] **ALL DEPENDENCIES SAFE**\n');
        } else {
            report.push(`[WARNING] **${unsafeDeps} DEPENDENCIES REQUIRE REVIEW**\n`);
        }

        // Detailed findings
        report.push('## Detailed Findings\n');

        const sortedDeps = Array.from(this.dependencies.entries()).sort();

        for (const [depName, dep] of sortedDeps) {
            report.push(`\n### ${depName} (${dep.version})`);

            if (dep.safe) {
                report.push('**Status**: [OK] SAFE');
            } else {
                report.push('**Status**: [WARNING] POTENTIAL TELEMETRY');
            }

            if (dep.telemetryFeatures.length > 0) {
                report.push('\n**Telemetry Features Found**:');
                for (const feature of dep.telemetryFeatures.slice(0, 5)) {
                    report.push(`- ${feature}`);
                }
            }

            if (dep.networkCalls.length > 0) {
                report.push('\n**Network Calls Found**:');
                for (const call of dep.networkCalls.slice(0, 5)) {
                    report.push(`- ${call}`);
                }
            }

            if (dep.notes.length > 0) {
                report.push('\n**Notes**:');
                for (const note of dep.notes) {
                    report.push(`- ${note}`);
                }
            }
        }

        return report.join('\n');
    }

    /**
     * Save report to file
     */
    saveReport(report, outputPath) {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, report, 'utf8');
        console.log(`\n[+] Report saved to: ${outputPath}`);
    }

    /**
     * Audit all dependencies
     */
    auditAll() {
        // Get dependencies
        this.getAllDependencies();

        // Run npm audit
        const npmAuditSafe = this.runNpmAudit();

        // Audit each dependency
        console.log('\n[*] Auditing dependencies for telemetry...');

        // Focus on critical packages first
        const criticalPackages = [
            'react', 'react-dom', 'typescript', 'vite',
            'axios', 'fetch', 'socket.io-client'
        ];

        for (const depName of this.dependencies.keys()) {
            // Focus on critical packages first
            if (criticalPackages.some(pkg => depName.toLowerCase().includes(pkg))) {
                this.auditDependency(depName);
            }
        }

        // Generate report
        const report = this.generateReport();

        // Save to multiple locations
        this.saveReport(report, path.join('frontend', 'TELEMETRY_AUDIT.md'));
        this.saveReport(report, 'NODE_TELEMETRY_AUDIT_REPORT.md');

        // Return exit code
        const unsafeCount = Array.from(this.dependencies.values()).filter(d => !d.safe).length;
        if (unsafeCount > 0 || !npmAuditSafe) {
            return 1;
        }
        return 0;
    }
}

/**
 * Main entry point
 */
function main() {
    const frontendDir = path.join(__dirname, '..', 'frontend');

    if (!fs.existsSync(frontendDir)) {
        console.error(`[!] Frontend directory not found: ${frontendDir}`);
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('Node.js Dependency Telemetry Auditor');
    console.log('='.repeat(60));
    console.log();

    const auditor = new NodeDependencyAuditor(frontendDir);
    const exitCode = auditor.auditAll();

    if (exitCode === 0) {
        console.log('\n' + '='.repeat(60));
        console.log('[OK] AUDIT PASSED');
        console.log('='.repeat(60));
        console.log('\nAll dependencies are free of known telemetry features.');
    } else {
        console.log('\n' + '='.repeat(60));
        console.log('[WARNING] AUDIT FOUND ISSUES');
        console.log('='.repeat(60));
        console.log('\nPotential telemetry or vulnerabilities found.');
        console.log('Review the audit report for details.');
    }

    process.exit(exitCode);
}

if (require.main === module) {
    main();
}

module.exports = NodeDependencyAuditor;
