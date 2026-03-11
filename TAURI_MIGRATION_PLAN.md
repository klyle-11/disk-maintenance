# Tauri Migration Plan

## Current Architecture Analysis

### Frontend
- **React 19.2** + TypeScript + Vite
- **API Client**: HTTP/REST API with Server-Sent Events for progress
- **UI Components**: Scan controls, findings table, snapshot gallery, comparison results

### Desktop Layer (Electron)
- **Electron 39.2.7** (minimal wrapper)
- Window creation and lifecycle management
- Directory dialog handling via IPC
- Security: context isolation, node integration disabled

### Backend (Python FastAPI)
- **FastAPI** with SQLite database
- **SQLAlchemy** ORM for snapshots
- **Business Logic**:
  - Disk scanning with progress tracking
  - File comparison (hash-based)
  - Snapshot management
  - Du-hast-much integration
- **Security Features**:
  - Path validation
  - Input sanitization
  - Secure logging
  - Security headers

## Migration Strategy

### Phase 1: Project Setup & Foundation
1. ✅ Create worktree for migration
2. Initialize Tauri project structure
3. Configure build system and dependencies
4. Set up Rust project with necessary crates

### Phase 2: Backend Logic Migration
1. Port database models from Python to Rust
2. Implement file scanning logic in Rust
3. Implement comparison logic in Rust
4. Port security features to Rust

### Phase 3: Tauri Integration
1. Create Tauri commands for all API endpoints
2. Set up IPC communication layer
3. Implement native dialog handlers
4. Configure progress event channels

### Phase 4: Frontend Adaptation
1. Replace HTTP client with Tauri invoke calls
2. Update progress tracking for event-based system
3. Test and validate all functionality

### Phase 5: Build & Deployment
1. Configure Tauri build settings
2. Set up code signing (if needed)
3. Test production builds
4. Update documentation

## Technical Decisions

### Rust Backend
**Decision**: Rewrite Python logic in Rust (not hybrid approach)

**Rationale**:
- Tauri works best with pure Rust backends
- Better performance for file operations
- Single binary deployment
- No Python runtime dependency
- Type safety and memory safety

### Database
**Decision**: Keep SQLite, migrate to Rust Diesel ORM

**Rationale**:
- SQLite is perfect for desktop app storage
- Diesel provides type-safe database access
- Single file database (easy deployment)
- Migrate existing schema seamlessly

### IPC Communication
**Decision**: Replace HTTP/REST with Tauri commands

**Rationale**:
- Direct function calls (faster)
- Type-safe via Tauri type system
- No network overhead
- Native async support

### Progress Updates
**Decision**: Replace SSE with Tauri event channels

**Rationale**:
- Native event system
- Better performance
- Type-safe events
- No HTTP overhead

## Implementation Roadmap

### Step 1: Initialize Tauri Project
```bash
npm install -D @tauri-apps/cli@latest
npm run tauri init
```

### Step 2: Rust Dependencies
```toml
[dependencies]
tauri = { version = "2.0", features = ["shell-open"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
walkdir = "2"  # For directory scanning
diesel = { version = "2", features = ["sqlite"] }
sha2 = "0.10"   # For file hashing
```

### Step 3: Database Migration
- Port SQLAlchemy models to Diesel entities
- Keep same SQLite schema for compatibility
- Implement migrations

### Step 4: Core Logic Porting
1. **File Scanning**: Implement in Rust using `walkdir`
2. **File Comparison**: Port hash-based comparison
3. **Du-hast-much**: Rewrite analysis logic
4. **Security**: Implement path validation and sanitization

### Step 5: Tauri Commands
Create Rust commands for:
- `scan_directory` → `cmd::scan`
- `compare_directories` → `cmd::compare`
- `save_snapshot` → `cmd::save_snapshot`
- `get_snapshots` → `cmd::get_snapshots`
- `dialog_select_directory` → Native Tauri API

## Benefits of Migration

### Performance
- **Startup**: ~100MB → ~10MB binary
- **Memory**: Lower RAM usage
- **Speed**: Native file operations

### Security
- **Attack Surface**: Smaller than Electron
- **Type Safety**: Rust memory safety
- **Sandboxing**: OS-native webview

### Developer Experience
- **Type Safety**: End-to-end type safety
- **Tooling**: Modern Rust ecosystem
- **Deployment**: Single binary distribution

## Challenges & Mitigations

### Challenge 1: Rewriting Python Logic
**Mitigation**: Incremental porting with comprehensive testing

### Challenge 2: Progress Event Handling
**Mitigation**: Use Tauri's event system for real-time updates

### Challenge 3: Database Migration
**Mitigation**: Keep schema compatible, migrate to Diesel

### Challenge 4: Cross-platform File Operations
**Mitigation**: Use Rust's cross-platform crates (`walkdir`, etc.)

## Timeline Estimate

- **Phase 1**: 1-2 days (Setup & foundation)
- **Phase 2**: 3-5 days (Backend logic migration)
- **Phase 3**: 2-3 days (Tauri integration)
- **Phase 4**: 2-3 days (Frontend adaptation)
- **Phase 5**: 1-2 days (Build & deployment)

**Total**: 9-15 days for complete migration

## Success Criteria

- ✅ All current features work in Tauri version
- ✅ Binary size < 20MB
- ✅ Startup time < 2 seconds
- ✅ Memory usage < 100MB
- ✅ Cross-platform builds (macOS, Windows, Linux)
- ✅ Existing database compatible
- ✅ All security features preserved