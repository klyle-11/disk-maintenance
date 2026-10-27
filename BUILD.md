# Building Disk Intelligence

The desktop app is a Tauri app: the React UI (`frontend/src/`) plus a Rust
core (`core/`) compiled into one native binary. There is no Python backend to
bundle, no port and no sidecar.

## Prerequisites

### All platforms
- Node.js 18+
- Rust (stable, 1.77+): https://rustup.rs

### Windows
- Microsoft C++ Build Tools ("Desktop development with C++")
- WebView2: built into Windows 11. On Windows 10 the installer downloads it.

### macOS
- Xcode Command Line Tools (`xcode-select --install`)
- macOS 10.15+

### Linux (Debian/Ubuntu/Raspberry Pi OS)
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Quick start

```bash
./scripts/package.sh            # macOS: .app + .dmg
./scripts/package-linux.sh      # Linux: .deb, .rpm, AppImage
```
```batch
scripts\package.bat             :: Windows: .msi + setup .exe
```

Each script runs `npm install` and then `npm run dist` (`tauri build`), which
builds the frontend, compiles the Rust core in release mode and bundles it.
Build each OS's installers on that OS.

## Manual steps

```bash
cd frontend
npm install
npm run dist                    # = tauri build
npx tauri build --bundles deb   # just one bundle type
npx tauri build --debug --no-bundle   # quick debug binary, no installer
```

Development:

```bash
cd frontend
npm run dev                     # Vite dev server + Tauri window, with hot reload
cargo test --manifest-path ../core/Cargo.toml   # core tests (no GUI needed)
```

## Output files

Everything lands in `frontend/src-tauri/target/release/bundle/`:

| Platform | Files |
|---|---|
| Windows | `msi/Disk Intelligence_1.0.0_x64_en-US.msi`, `nsis/Disk Intelligence_1.0.0_x64-setup.exe` |
| macOS | `macos/Disk Intelligence.app`, `dmg/Disk Intelligence_1.0.0_aarch64.dmg` (or `_x64`) |
| Linux | `deb/Disk Intelligence_1.0.0_amd64.deb`, `rpm/…`, `appimage/…` (arm64 on ARM) |

### Raspberry Pi / Linux arm64

Build on the Pi itself (a Pi 5 is fine; the first Rust build takes a while).
Install the Linux packages above plus Node.js and Rust, then run
`./scripts/package-linux.sh`. Install the result with
`sudo apt install ./frontend/src-tauri/target/release/bundle/deb/*.deb`.
The AppImage needs `libfuse2` (`libfuse2t64` on Pi OS "trixie") to run.

## App icon

The source is `frontend/src-tauri/icons/icon.svg` (a #FFFFFC wrench on a
#6414D9 square). After editing it, regenerate every size with:

```bash
cd frontend && npm run icons
```

`frontend/public/icon.svg` (the window favicon) and `frontend/build/icon.png`
(the legacy Electron build) are copies of the same icon.

## Database location

Snapshots live in the same SQLite file the Electron app used, so they carry over:

- Windows: `%APPDATA%\DiskIntelligence\disk_intelligence.db`
- macOS: `~/Library/Application Support/DiskIntelligence/disk_intelligence.db`
- Linux: `~/.local/share/DiskIntelligence/disk_intelligence.db`

## Code signing

Builds are unsigned by default. On macOS they get an ad-hoc signature
(`signingIdentity: "-"` in `tauri.conf.json`), which Apple Silicon needs to run
the app at all; the first launch may need right-click → Open.

- **macOS**: set `APPLE_SIGNING_IDENTITY` (and `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD` in CI). For notarization also set `APPLE_ID`,
  `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.
- **Windows**: set `bundle.windows.certificateThumbprint` (or a `signCommand`)
  in `tauri.conf.json`. See https://v2.tauri.app/distribute/sign/windows/.

## Troubleshooting

- **`webkit2gtk-4.1` not found (Linux)**: install the packages listed above.
- **Stale build**: `cargo clean --manifest-path frontend/src-tauri/Cargo.toml`.
- **Blank window in dev**: the Vite server must be on 127.0.0.1:5176
  (`npm run dev` starts it for you).

## Legacy Electron + Python build

The previous app (Electron shell + PyInstaller-bundled FastAPI backend) still
builds until it is removed:

```bash
./scripts/build-backend.sh                     # PyInstaller → backend/dist/
npm --prefix frontend run dist:electron:mac    # or :win / :linux → release/
npm run verify                                 # checks the packaged backend
npm run dev:electron                           # dev: Python backend + Electron
```

It needs Python 3.10+ and `pip install -r backend/requirements.txt`.
