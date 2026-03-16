# Building Disk Intelligence

This document describes how to build and package Disk Intelligence for distribution.

## Prerequisites

### Common
- Node.js 18+
- Python 3.10+

### Windows
- Visual Studio Build Tools (for native dependencies)
- NSIS (included with electron-builder)

### macOS
- Xcode Command Line Tools
- macOS 10.14+

## Quick Start

### Windows
```batch
scripts\package.bat
```

### macOS/Linux
```bash
./scripts/package.sh
```

This will:
1. Build the Python backend with PyInstaller
2. Install frontend npm dependencies
3. Build the React/Vite frontend
4. Package everything with electron-builder

## Manual Build Steps

### 1. Build Backend

**Windows:**
```batch
cd backend
pyinstaller disk-intelligence.spec --clean
```

**macOS/Linux:**
```bash
cd backend
python3 -m PyInstaller disk-intelligence.spec --clean
```

Output: `backend/dist/disk-intelligence-backend` (or `.exe` on Windows)

### 2. Build Frontend

```bash
cd frontend
npm install
npm run build
```

Output: `frontend/dist/` with built React app

### 3. Package Full App

**Windows (NSIS installer):**
```bash
cd frontend
npm run dist:win
```

**macOS (DMG):**
```bash
cd frontend
npm run dist:mac
```

**Linux (AppImage):**
```bash
cd frontend
npm run dist:linux
```

## Output Files

After building, you'll find:

### Windows
- `release/Disk Intelligence Setup 1.0.0.exe` - NSIS installer
- `release/win-unpacked/` - Unpacked application

### macOS
- `release/Disk Intelligence 1.0.0.dmg` - DMG disk image
- `release/Disk Intelligence.app` - Application bundle

### Linux
- `release/disk-intelligence-1.0.0.AppImage` - AppImage bundle

## Development Builds

For development testing without full packaging:

```bash
# Terminal 1: Backend
cd backend
python main.py

# Terminal 2: Frontend
cd frontend
npm run dev
```

## Database Location

The SQLite database is stored in:
- **Development**: `backend/disk_intelligence.db`
- **Production**:
  - Windows: `%APPDATA%\DiskIntelligence\disk_intelligence.db`
  - macOS: `~/Library/Application Support/DiskIntelligence/disk_intelligence.db`
  - Linux: `~/.local/share/DiskIntelligence/disk_intelligence.db`

## Code Signing

By default, builds are unsigned. For distribution, you'll need to:

### Windows
1. Get a code signing certificate
2. Set `CSC_LINK` environment variable to certificate path
3. Set `CSC_KEY_PASSWORD` to certificate password

### macOS
1. Get an Apple Developer certificate
2. Set `CSC_LINK` to certificate .p12 file path
3. Set `CSC_KEY_PASSWORD` to certificate password
4. For notarization, set `APPLE_ID` and `APPLE_ID_PASSWORD`

## Troubleshooting

### PyInstaller Issues
- Clean build cache: `pyinstaller --clean`
- Check hidden imports in `disk-intelligence.spec`

### Electron Builder Issues
- Clean: `rm -rf frontend/node_modules frontend/dist release`
- Rebuild: `npm install` then build again
- Check platform-specific requirements

### Import Errors
- Ensure `backend/__init__.py` exists
- Verify `backend/security/__init__.py` exists
- Check pathex in spec file includes project root

## File Structure After Build

```
Disk Intelligence.app (or .exe)
├── resources/
│   ├── app.asar        # Frontend (React app)
│   └── backend/
│       └── disk-intelligence-backend    # Python FastAPI server
└── Disk Intelligence     # Electron launcher
```

The Electron app:
1. Launches the backend executable on startup
2. Waits for backend to be ready (port 8001)
3. Loads the React frontend
4. Shuts down backend on exit
