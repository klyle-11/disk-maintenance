# Disk Intelligence

A cross-platform disk analysis and maintenance tool built with Electron (React frontend) and FastAPI (Python backend).

## Features

- 🔍 **Deep Disk Scanning** - Scan directories to find large files, duplicates, cache folders, and more
- 📊 **File Type Analysis** - Break down disk usage by file extension
- 📁 **Directory Comparison** - Compare two directories to identify differences
- 💾 **Snapshot Management** - Save scan results to track changes over time
- 🎨 **Multiple Themes** - Light, Dark, Sepia, and Dark Sepia themes
- 🔒 **Read-Only** - Safe analysis that doesn't modify your files

## Platform Support

- ✅ Windows (10/11)
- ✅ macOS (10.14+)
- ✅ Linux (Ubuntu, Fedora, Debian, etc.)

## Prerequisites

### Common
- Node.js 18+ and npm
- Python 3.10+

### Windows
- PowerShell 5.1+ (pre-installed)

### macOS
- Homebrew (recommended, for installing Python)
- Xcode Command Line Tools (for building native modules)

## Installation

### Windows

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd disk-maintenance
   ```

2. Run the setup script:
   ```bash
   run.bat
   ```

   This will:
   - Install Python dependencies
   - Install Node.js dependencies
   - Start the backend server
   - Launch the Electron app

### macOS / Linux

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd disk-maintenance
   ```

2. Make scripts executable (first time only):
   ```bash
   chmod +x run.sh run-dev.sh run-backend.sh
   ```

3. Run the setup script:
   ```bash
   ./run.sh
   ```

   This will:
   - Create a Python virtual environment
   - Install Python dependencies
   - Install Node.js dependencies
   - Start the backend server
   - Launch the Electron app

## Running the Application

### First Time Setup

**Windows:**
```bash
run.bat
```

**macOS/Linux:**
```bash
./run.sh
```

### Quick Development Mode (After Setup)

**Windows:**
```bash
run-dev.bat
```

**macOS/Linux:**
```bash
./run-dev.sh
```

### Backend Only

**Windows:**
```bash
run-backend.bat
```

**macOS/Linux:**
```bash
./run-backend.sh
```

## Manual Setup (Advanced)

If you prefer to set up components manually:

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Create a virtual environment:
   ```bash
   python -m venv venv  # Windows
   python3 -m venv venv  # macOS/Linux
   ```

3. Activate the virtual environment:
   ```bash
   venv\Scripts\activate  # Windows
   source venv/bin/activate  # macOS/Linux
   ```

4. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

5. Start the backend:
   ```bash
   python main.py  # Windows
   python3 main.py  # macOS/Linux
   ```

   The backend will run on `http://127.0.0.1:8001`

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   npm run preview
   ```

## Architecture

### Backend (Python/FastAPI)
- **`main.py`** - Main FastAPI application with scan, analysis, and comparison endpoints
- **`database.py`** - SQLite database for storing snapshots
- **Port:** 8001

### Frontend (Electron/React)
- **`src/App.tsx`** - Main application component
- **`src/api.ts`** - API client for communicating with backend
- **`src/components/`** - React components (ScanControls, ScanResults, etc.)
- **`electron/`** - Electron main process and preload scripts

## Themes

The application supports four themes:

1. **Light** - Clean, modern light theme
2. **Dark** - Catppuccin Mocha-inspired dark theme
3. **Sepia** - Light earthy tones with Papyrus font
4. **Dark Sepia** - Dark earthy tones with bold gold accents and Papyrus font

Themes can be switched from the dropdown in the header.

## Database

The application uses SQLite for storing snapshots. The database file (`disk_intelligence.db`) is created automatically in the project root and is **not** tracked by git.

## Development

### Project Structure

```
disk-maintenance/
├── backend/              # Python FastAPI backend
│   ├── main.py          # Main application
│   ├── database.py      # SQLite database models
│   └── requirements.txt # Python dependencies
├── frontend/           # Electron/React frontend
│   ├── electron/       # Electron main process
│   ├── src/           # React source code
│   │   ├── components/
│   │   ├── api.ts
│   │   └── App.tsx
│   └── package.json
├── run.bat            # Windows setup script
├── run-dev.bat       # Windows quick start
├── run.sh            # macOS/Linux setup script
├── run-dev.sh       # macOS/Linux quick start
└── README.md
```

### Troubleshooting

#### Python not found
- **Windows:** Download from https://www.python.org/ and ensure "Add to PATH" is checked during installation
- **macOS:** Install via Homebrew: `brew install python3`
- **Linux:** Install via package manager: `sudo apt install python3 python3-pip` (Ubuntu/Debian)

#### Node.js not found
- Download from https://nodejs.org/ or install via package manager:
  - **Windows:** Use the installer
  - **macOS:** `brew install node`
  - **Linux:** `sudo apt install nodejs npm` (Ubuntu/Debian)

#### Permission errors during scan
- The scanner skips files/folders it doesn't have permission to access
- On macOS, you may need to grant Full Disk Access to the application in System Settings > Privacy & Security

#### Backend connection failed
- Ensure the backend is running on port 8001
- Check firewall settings
- Verify no other application is using port 8001

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]
