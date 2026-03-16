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
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
# du-hast-much is a sibling project in the workspace (../du-hast-much relative to project root)
DU_HAST_MUCH_PATH = os.environ.get(
    'DU_HAST_MUCH_PATH',
    os.path.join(PROJECT_ROOT, '..', 'du-hast-much')
)

a = Analysis(
    ['main.py'],
    pathex=[BACKEND_DIR, PROJECT_ROOT, DU_HAST_MUCH_PATH],
    binaries=[],
    datas=[
        (os.path.join(BACKEND_DIR, 'security'), 'security'),
        (os.path.join(BACKEND_DIR, 'database.py'), '.'),
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
