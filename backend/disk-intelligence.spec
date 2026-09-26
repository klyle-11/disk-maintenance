# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Disk Intelligence Backend.
Bundles the FastAPI backend into a standalone executable.

Usage:
    cd backend
    pyinstaller disk-intelligence.spec --clean
"""

import os
import sys

# Get paths - assuming we run from backend directory
BACKEND_DIR = os.getcwd()

a = Analysis(
    ['main.py'],
    pathex=[BACKEND_DIR],
    binaries=[],
    datas=[
        (os.path.join(BACKEND_DIR, 'security'), 'backend/security'),
        (os.path.join(BACKEND_DIR, 'du_hast_much.py'), 'backend'),
        (os.path.join(BACKEND_DIR, 'database.py'), 'backend'),
        (os.path.join(BACKEND_DIR, '__init__.py'), 'backend'),
        (os.path.join(BACKEND_DIR, 'diskcli'), 'backend/diskcli'),
    ],
    hiddenimports=[
        'uvicorn', 'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
        'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on', 'uvicorn.lifespan.off',
        'fastapi', 'fastapi.middleware', 'fastapi.middleware.cors',
        'pydantic', 'pydantic.dataclasses',
        'sqlalchemy', 'sqlalchemy.dialects.sqlite', 'sqlalchemy.orm',
        'du_hast_much',
        'security', 'security.path_validator',
        'security.input_sanitizer', 'security.secure_logger',
        'security.headers', 'security.encryption',
        'database',
        'diskcli', 'diskcli.tips', 'diskcli.store',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'scipy', 'PIL', 'cv2', 'test', 'unittest'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, a.binaries, a.datas,
    [],
    name='disk-intelligence-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is off deliberately. On macOS it invalidates the code signature,
    # which makes Gatekeeper kill the binary on launch; on Windows it is a
    # reliable way to get flagged by antivirus. The size saving is not worth
    # a backend that will not start.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    # Keep the console subsystem so stdout/stderr reach the launcher and end
    # up in the log. With console=False the process is silent, which is why a
    # failure to start used to produce no diagnostics at all.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    # Entitlements matter on macOS: the app runs under a hardened runtime, and
    # the backend has to read files all over the disk to do its job.
    entitlements_file=(
        os.path.join(BACKEND_DIR, 'entitlements.plist')
        if sys.platform == 'darwin'
        and os.path.exists(os.path.join(BACKEND_DIR, 'entitlements.plist'))
        else None
    ),
    icon=None,
)
