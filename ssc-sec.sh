#!/bin/bash
echo "--- Checking for Axios Supply Chain Compromise ---"

# 1. Check node_modules for malicious plain-crypto-js
if [ -d "node_modules/plain-crypto-js" ]; then
    echo "[!] DANGER: plain-crypto-js found in node_modules"
else
    echo "[+] plain-crypto-js not found in node_modules"
fi

# 2. Check package-lock.json for compromised versions
if [ -f "package-lock.json" ]; then
    grep -E 'axios@1\.14\.1|axios@0\.30\.4' package-lock.json && echo "[!] DANGER: Compromised axios found in package-lock.json" || echo "[+] package-lock.json appears clean"
fi

# 3. Check for RAT artifacts (macOS)
if [ -f "/Library/Caches/com.apple.act.mond" ]; then
    echo "[!] DANGER: RAT artifact found at /Library/Caches/com.apple.act.mond"
fi

# 4. Check for RAT artifacts (Linux)
if [ -f "/tmp/ld.py" ]; then
    echo "[!] DANGER: RAT artifact found at /tmp/ld.py"
fi
