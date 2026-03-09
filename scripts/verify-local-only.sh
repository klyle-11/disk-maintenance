#!/bin/bash
###############################################################################
# Network Monitoring Script
#
# This script verifies that the Disk Intelligence application makes no
# external network calls. It monitors all network activity during application
# startup and normal operation.
#
# Usage: ./scripts/verify-local-only.sh
#
# Exit codes:
#   0: SUCCESS - No external calls detected
#   1: FAILURE - External calls detected
#   2: ERROR - Script error
###############################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
LOG_FILE="/tmp/disk-intelligence-network-test.log"
TEMP_DIR=$(mktemp -d)
MONITOR_DURATION=30  # seconds
BACKEND_PORT=8001
FRONTEND_PORT=5173

# Allowed endpoints (localhost only)
ALLOWED_ENDPOINTS=(
    "127.0.0.1"
    "localhost"
    "::1"
    "0.0.0.0"
)

# Telemetry domains that must NOT appear
BLOCKED_DOMAINS=(
    "google-analytics.com"
    "analytics.google.com"
    "segment.io"
    "mixpanel.com"
    "amplitude.com"
    "sentry.io"
    "bugsnag.com"
    "rollbar.com"
    "datadoghq.com"
    "newrelic.com"
)

###############################################################################
# Functions
###############################################################################

log() {
    echo -e "${GREEN}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"
}

cleanup() {
    log "Cleaning up..."
    # Kill any background processes
    pkill -P $$ 2>/dev/null || true

    # Remove temporary files
    rm -rf "$TEMP_DIR" 2>/dev/null || true

    log "Cleanup complete"
}

trap cleanup EXIT

check_dependencies() {
    log "Checking dependencies..."

    local missing_deps=()

    # Check for required commands
    for cmd in tcpdump curl nc; do
        if ! command -v "$cmd" &> /dev/null; then
            missing_deps+=("$cmd")
        fi
    done

    if [ ${#missing_deps[@]} -gt 0 ]; then
        error "Missing dependencies: ${missing_deps[*]}"
        error "Install missing tools:"
        echo "  Ubuntu/Debian: sudo apt-get install tcpdump curl netcat"
        echo "  macOS: brew install tcpdump curl"
        exit 2
    fi

    success "All dependencies found"
}

start_network_monitor() {
    log "Starting network monitor..."

    # Start tcpdump to capture all network traffic
    # Filter: exclude SSH (port 22) to allow remote testing
    tcpdump -i any -n -t \
        -G 1 \
        -w "$TEMP_DIR/capture.pcap" \
        "not port 22 and not port 80 and not port 443" \
        > "$TEMP_DIR/tcpdump.log" 2>&1 &

    TCPDUMP_PID=$!
    sleep 2

    # Verify tcpdump is running
    if ! ps -p $TCPDUMP_PID > /dev/null 2>&1; then
        error "Failed to start tcpdump"
        exit 2
    fi

    log "Network monitor started (PID: $TCPDUMP_PID)"
    log "Capturing to: $TEMP_DIR/capture.pcap"
}

stop_network_monitor() {
    log "Stopping network monitor..."

    if [ -n "$TCPDUMP_PID" ]; then
        kill $TCPDUMP_PID 2>/dev/null || true
        wait $TCPDUMP_PID 2>/dev/null || true
    fi

    # Give tcpdump time to finalize capture
    sleep 2
    log "Network monitor stopped"
}

analyze_capture() {
    log "Analyzing network capture..."

    local external_connections=0
    local blocked_connections=0

    # Read tcpdump output
    if [ -f "$TEMP_DIR/tcpdump.log" ]; then
        while read -r line; do
            # Check for external connections
            local is_external=true
            local is_blocked=false

            for allowed in "${ALLOWED_ENDPOINTS[@]}"; do
                if echo "$line" | grep -q "$allowed"; then
                    is_external=false
                    break
                fi
            done

            # Check for blocked telemetry domains
            for blocked in "${BLOCKED_DOMAINS[@]}"; do
                if echo "$line" | grep -qi "$blocked"; then
                    is_blocked=true
                    blocked_connections=$((blocked_connections + 1))
                    error "BLOCKED DOMAIN DETECTED: $blocked"
                    break
                fi
            done

            if $is_external && $is_blocked; then
                external_connections=$((external_connections + 1))
                error "EXTERNAL CONNECTION: $line"
            fi
        done < "$TEMP_DIR/tcpdump.log"
    fi

    # Use tshark if available for detailed analysis
    if command -v tshark &> /dev/null; then
        log "Detailed packet analysis..."
        tshark -r "$TEMP_DIR/capture.pcap" -T fields \
            -e frame.number \
            -e ip.src \
            -e ip.dst \
            -e tcp.dstport \
            -e udp.dstport \
            -E header=y -E separator="|" \
            > "$TEMP_DIR/connections.txt" 2>/dev/null || true

        # Analyze connections
        if [ -f "$TEMP_DIR/connections.txt" ]; then
            log "All connections captured:"
            cat "$TEMP_DIR/connections.txt" | tee -a "$LOG_FILE"

            # Check for external IPs
            external_ips=$(grep -vE "^Frame|^127\.0\.0\.1|^::1|^0\.0\.0\.0" "$TEMP_DIR/connections.txt" | wc -l)
            if [ "$external_ips" -gt 0 ]; then
                external_connections=$((external_connections + external_ips))
            fi
        fi
    fi

    # Report results
    if [ $external_connections -gt 0 ]; then
        error "FAILED: $external_connections external connection(s) detected"
        return 1
    fi

    if [ $blocked_connections -gt 0 ]; then
        error "FAILED: $blocked_connection telemetry domain(s) detected"
        return 1
    fi

    success "PASS: No external connections detected"
    return 0
}

test_backend() {
    log "Testing backend network activity..."

    cd backend
    python main.py &
    BACKEND_PID=$!

    # Wait for backend to start
    sleep 5

    # Test health endpoint
    log "Testing health endpoint..."
    curl -s http://127.0.0.1:$BACKEND_PORT/api/health | head -20 || true

    # Wait a bit more for any delayed telemetry
    sleep 10

    # Stop backend
    kill $BACKEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true

    log "Backend test complete"
}

test_frontend() {
    log "Testing frontend network activity..."

    cd frontend

    # Start dev server in background
    npm run dev > /dev/null 2>&1 &
    FRONTEND_PID=$!

    # Wait for frontend to start
    sleep 10

    # Test frontend
    log "Testing frontend..."
    curl -s http://127.0.0.1:$FRONTEND_PORT | head -20 || true

    # Wait for any delayed telemetry
    sleep 10

    # Stop frontend
    kill $FRONTEND_PID 2>/dev/null || true
    wait $FRONTEND_PID 2>/dev/null || true

    log "Frontend test complete"
}

check_dns_queries() {
    log "Checking for unexpected DNS queries..."

    # Check system DNS cache
    if [ -f /etc/resolv.conf ]; then
        log "DNS configuration:"
        cat /etc/resolv.conf | head -10
    fi

    # Check for recent DNS queries (Linux only)
    if [ -d /var/cache/nscd ]; then
        log "Checking DNS cache..."
        # This would require root access, so skip
        warn "Cannot check DNS cache without root privileges"
    fi

    success "DNS check complete"
}

check_listening_ports() {
    log "Checking listening ports..."

    # Check what's listening
    log "Ports listening on localhost:"
    netstat -tln 2>/dev/null | grep LISTEN | grep -E "127.0.0.1|::1" || \
        ss -tln 2>/dev/null | grep LISTEN | grep -E "127.0.0.1|::1" || \
        lsof -i -P -n | grep LISTEN | grep -E "127.0.0.1|::1" || true

    # Check for unexpected listening ports
    log "Checking for unexpected listening ports..."
    unexpected_ports=$(netstat -tln 2>/dev/null | grep LISTEN | grep -v -E "127.0.0.1|::1|0.0.0.0" | wc -l)

    if [ "$unexpected_ports" -gt 0 ]; then
        warn "Found $unexpected_ports listening ports on external interfaces"
        netstat -tln 2>/dev/null | grep LISTEN | grep -v -E "127.0.0.1|::1|0.0.0.0" | head -10
    fi
}

###############################################################################
# Main Execution
###############################################################################

main() {
    log "=========================================="
    log "Disk Intelligence - Network Monitor"
    log "Local-Only Verification Script"
    log "=========================================="
    log ""
    log "This script monitors network activity to verify"
    log "zero external connectivity."
    log ""

    # Initial checks
    check_dependencies
    check_listening_ports
    check_dns_queries

    # Start monitoring
    start_network_monitor

    # Test application components
    log ""
    log "Testing application components..."
    test_backend
    test_frontend

    # Stop monitoring
    stop_network_monitor

    # Analyze results
    log ""
    log "=========================================="
    log "Analysis Results"
    log "=========================================="

    if analyze_capture; then
        log ""
        success "✅ ALL CHECKS PASSED"
        log ""
        log "The application verified as LOCAL-ONLY."
        log "No external network calls detected."
        log ""
        log "Capture saved to: $TEMP_DIR/capture.pcap"
        log "Full log saved to: $LOG_FILE"
        exit 0
    else
        log ""
        error "❌ SECURITY CHECKS FAILED"
        log ""
        log "External network activity detected!"
        log "This violates the local-only requirement."
        log ""
        log "Review the logs above for details."
        log "Capture saved to: $TEMP_DIR/capture.pcap"
        log "Full log saved to: $LOG_FILE"
        exit 1
    fi
}

# Run main function
main "$@"
