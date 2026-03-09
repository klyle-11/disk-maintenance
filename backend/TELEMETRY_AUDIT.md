# Python Dependency Telemetry Audit Report

Generated: 2026-03-09

## Executive Summary
- Total Dependencies: 156
- Safe Dependencies: 152
- Dependencies with Potential Telemetry: 4

[WARNING] **4 DEPENDENCIES REQUIRE REVIEW**

## Detailed Findings

### CacheControl (0.14.4)
**Status**: [OK] SAFE

### Flask (3.1.2)
**Status**: [OK] SAFE

### Jinja2 (3.1.6)
**Status**: [OK] SAFE

### MarkupSafe (3.0.3)
**Status**: [OK] SAFE

### PySide6-Essentials (6.5.2)
**Status**: [OK] SAFE

### PySocks (1.7.1)
**Status**: [OK] SAFE

### PyYAML (6.0.3)
**Status**: [OK] SAFE

### Pygments (2.19.2)
**Status**: [OK] SAFE

### SQLAlchemy (2.0.45)
**Status**: [OK] SAFE

### Scweet (1.8)
**Status**: [OK] SAFE

### Werkzeug (3.1.3)
**Status**: [OK] SAFE

### altgraph (0.17.4)
**Status**: [OK] SAFE

### annotated-doc (0.0.4)
**Status**: [OK] SAFE

### annotated-types (0.7.0)
**Status**: [OK] SAFE

### anyio (4.12.1)
**Status**: [OK] SAFE

### async-generator (1.10)
**Status**: [OK] SAFE

### attrs (22.1.0)
**Status**: [OK] SAFE

### babel (2.17.0)
**Status**: [OK] SAFE

### beautifulsoup4 (4.14.3)
**Status**: [OK] SAFE

### blinker (1.9.0)
**Status**: [OK] SAFE

### blis (1.3.3)
**Status**: [OK] SAFE

### boolean.py (5.0)
**Status**: [OK] SAFE

### catalogue (2.0.10)
**Status**: [OK] SAFE

### certifi (2022.9.24)
**Status**: [OK] SAFE

### cffi (1.15.1)
**Status**: [OK] SAFE

### chardet (5.2.0)
**Status**: [OK] SAFE

### charset-normalizer (3.4.4)
**Status**: [OK] SAFE

### chromedriver-autoinstaller (0.4.0)
**Status**: [OK] SAFE

### chromium (0.0.0)
**Status**: [OK] SAFE

### click (8.3.0)
**Status**: [OK] SAFE

### cloudpathlib (0.23.0)
**Status**: [OK] SAFE

### colorama (0.4.6)
**Status**: [OK] SAFE

### confection (0.1.5)
**Status**: [OK] SAFE

### courlan (1.3.2)
**Status**: [OK] SAFE

### cryptography (38.0.3)
**Status**: [OK] SAFE

### cssselect (1.3.0)
**Status**: [OK] SAFE

### cyclonedx-python-lib (11.6.0)
**Status**: [OK] SAFE

### cymem (2.0.13)
**Status**: [OK] SAFE

### dateparser (1.2.2)
**Status**: [OK] SAFE

### defusedxml (0.7.1)
**Status**: [OK] SAFE

### docx2pdf (0.1.8)
**Status**: [OK] SAFE

### extruct (0.18.0)
**Status**: [OK] SAFE

### fastapi (0.128.0)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Network Calls Found**:
- applications.py: requests.
- applications.py: Socket.
- applications.py: Socket.
- applications.py: socket.
- applications.py: socket.

### filelock (3.20.3)
**Status**: [OK] SAFE

### flask-cors (6.0.1)
**Status**: [OK] SAFE

### fonttools (4.61.1)
**Status**: [OK] SAFE

### fpdf2 (2.8.5)
**Status**: [OK] SAFE

### fsspec (2026.1.0)
**Status**: [OK] SAFE

### geckodriver-autoinstaller (0.1.0)
**Status**: [OK] SAFE

### git-filter-repo (2.47.0)
**Status**: [OK] SAFE

### greenlet (3.3.0)
**Status**: [OK] SAFE

### h11 (0.16.0)
**Status**: [OK] SAFE

### html-text (0.7.1)
**Status**: [OK] SAFE

### html5lib (1.1)
**Status**: [OK] SAFE

### htmldate (1.9.4)
**Status**: [OK] SAFE

### httptools (0.7.1)
**Status**: [OK] SAFE

### huggingface-hub (0.36.0)
**Status**: [OK] SAFE

### idna (3.4)
**Status**: [OK] SAFE

### iniconfig (2.3.0)
**Status**: [OK] SAFE

### itsdangerous (2.2.0)
**Status**: [OK] SAFE

### joblib (1.5.3)
**Status**: [OK] SAFE

### jstyleson (0.0.2)
**Status**: [OK] SAFE

### jusText (3.0.2)
**Status**: [OK] SAFE

### license-expression (30.4.4)
**Status**: [OK] SAFE

### lxml (6.0.2)
**Status**: [OK] SAFE

### lxml_html_clean (0.4.3)
**Status**: [OK] SAFE

### markdown-it-py (4.0.0)
**Status**: [OK] SAFE

### mdurl (0.1.2)
**Status**: [OK] SAFE

### mf2py (2.0.1)
**Status**: [OK] SAFE

### mpmath (1.3.0)
**Status**: [OK] SAFE

### msgpack (1.1.2)
**Status**: [OK] SAFE

### murmurhash (1.0.15)
**Status**: [OK] SAFE

### networkx (3.6.1)
**Status**: [OK] SAFE

### numpy (2.4.1)
**Status**: [OK] SAFE

### outcome (1.2.0)
**Status**: [OK] SAFE

### packageurl-python (0.17.6)
**Status**: [OK] SAFE

### packaging (23.2)
**Status**: [OK] SAFE

### pandas (1.5.1)
**Status**: [OK] SAFE

### pefile (2023.2.7)
**Status**: [OK] SAFE

### pillow (12.1.0)
**Status**: [OK] SAFE

### pip-api (0.0.34)
**Status**: [OK] SAFE

### pip-requirements-parser (32.0.1)
**Status**: [OK] SAFE

### pip_audit (2.10.0)
**Status**: [OK] SAFE

### platformdirs (4.9.4)
**Status**: [OK] SAFE

### playwright (1.57.0)
**Status**: [OK] SAFE

### pluggy (1.6.0)
**Status**: [OK] SAFE

### preshed (3.0.12)
**Status**: [OK] SAFE

### py-serializable (2.1.0)
**Status**: [OK] SAFE

### pyOpenSSL (22.1.0)
**Status**: [OK] SAFE

### pyRdfa3 (3.6.4)
**Status**: [OK] SAFE

### pycparser (2.21)
**Status**: [OK] SAFE

### pydantic (2.12.5)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Telemetry Features Found**:
- config.py: tracking
- fields.py: Tracking
- v1\_hypothesis_plugin.py: tracking
- _internal\_discriminated_union.py: Tracking

**Network Calls Found**:
- dataclasses.py: fetch
- type_adapter.py: fetch
- type_adapter.py: fetch
- type_adapter.py: fetch
- type_adapter.py: fetch

### pydantic_core (2.41.5)
**Status**: [OK] SAFE

### pyee (13.0.0)
**Status**: [OK] SAFE

### pyinstaller (6.0.0)
**Status**: [OK] SAFE

### pyinstaller-hooks-contrib (2023.9)
**Status**: [OK] SAFE

### pynput (1.8.1)
**Status**: [OK] SAFE

### pyparsing (3.3.1)
**Status**: [OK] SAFE

### pytest (9.0.2)
**Status**: [OK] SAFE

### python-dateutil (2.9.0.post0)
**Status**: [OK] SAFE

### python-docx (1.2.0)
**Status**: [OK] SAFE

### python-dotenv (0.21.0)
**Status**: [OK] SAFE

### python-multipart (0.0.21)
**Status**: [OK] SAFE

### pytz (2025.2)
**Status**: [OK] SAFE

### pywin32 (311)
**Status**: [OK] SAFE

### pywin32-ctypes (0.2.2)
**Status**: [OK] SAFE

### rdflib (7.5.0)
**Status**: [OK] SAFE

### readability-lxml (0.8.4.1)
**Status**: [OK] SAFE

### regex (2025.11.3)
**Status**: [OK] SAFE

### requests (2.32.5)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Network Calls Found**:
- adapters.py: requests.
- adapters.py: requests.
- adapters.py: requests.
- adapters.py: requests.
- adapters.py: requests.

### rich (14.3.3)
**Status**: [OK] SAFE

### safetensors (0.7.0)
**Status**: [OK] SAFE

### scikit-learn (1.8.0)
**Status**: [OK] SAFE

### scipy (1.17.0)
**Status**: [OK] SAFE

### selenium (4.2.0)
**Status**: [OK] SAFE

### sentence-transformers (5.2.0)
**Status**: [OK] SAFE

### shiboken6 (6.5.2)
**Status**: [OK] SAFE

### six (1.16.0)
**Status**: [OK] SAFE

### smart_open (7.5.0)
**Status**: [OK] SAFE

### sniffio (1.3.0)
**Status**: [OK] SAFE

### sortedcontainers (2.4.0)
**Status**: [OK] SAFE

### soupsieve (2.8.1)
**Status**: [OK] SAFE

### spacy (3.8.11)
**Status**: [OK] SAFE

### spacy-legacy (3.0.12)
**Status**: [OK] SAFE

### spacy-loggers (1.0.5)
**Status**: [OK] SAFE

### srsly (2.5.2)
**Status**: [OK] SAFE

### starlette (0.50.0)
**Status**: [OK] SAFE

### sympy (1.14.0)
**Status**: [OK] SAFE

### thinc (8.3.10)
**Status**: [OK] SAFE

### threadpoolctl (3.6.0)
**Status**: [OK] SAFE

### tld (0.13.1)
**Status**: [OK] SAFE

### tokenizers (0.22.2)
**Status**: [OK] SAFE

### tomli (2.4.0)
**Status**: [OK] SAFE

### tomli_w (1.2.0)
**Status**: [OK] SAFE

### torch (2.9.1)
**Status**: [OK] SAFE

### tqdm (4.66.1)
**Status**: [OK] SAFE

### trafilatura (2.0.0)
**Status**: [OK] SAFE

### transformers (4.57.5)
**Status**: [OK] SAFE

### trio (0.22.0)
**Status**: [OK] SAFE

### trio-websocket (0.9.2)
**Status**: [OK] SAFE

### typer-slim (0.21.1)
**Status**: [OK] SAFE

### typing-inspection (0.4.2)
**Status**: [OK] SAFE

### typing_extensions (4.15.0)
**Status**: [OK] SAFE

### tzdata (2025.3)
**Status**: [OK] SAFE

### tzlocal (5.3.1)
**Status**: [OK] SAFE

### urllib3 (1.26.12)
**Status**: [OK] SAFE

### urllib3-secure-extra (0.1.0)
**Status**: [OK] SAFE

### uvicorn (0.40.0)
**Status**: [WARNING] POTENTIAL TELEMETRY

**Network Calls Found**:
- config.py: socket.
- config.py: socket.
- config.py: socket.
- config.py: socket.
- config.py: socket.

### w3lib (2.3.1)
**Status**: [OK] SAFE

### wasabi (1.1.3)
**Status**: [OK] SAFE

### watchfiles (1.1.1)
**Status**: [OK] SAFE

### weasel (0.4.3)
**Status**: [OK] SAFE

### webencodings (0.5.1)
**Status**: [OK] SAFE

### websockets (16.0)
**Status**: [OK] SAFE

### wrapt (2.0.1)
**Status**: [OK] SAFE

### wsproto (1.2.0)
**Status**: [OK] SAFE