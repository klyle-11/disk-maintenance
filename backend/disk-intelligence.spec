# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Disk Intelligence Backend.
Bundles the FastAPI backend into a standalone executable.

Usage:
    cd backend
    pyinstaller disk-intelligence.spec
"""

import os

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
        'backend', 'backend.security', 'backend.security.path_validator',
        'backend.security.input_sanitizer', 'backend.security.secure_logger',
        'backend.security.headers', 'backend.security.encryption',
        'database',
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
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
