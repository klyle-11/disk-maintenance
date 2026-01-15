"""
Database models and setup for Disk Intelligence snapshots.
"""

from sqlalchemy import create_engine, Column, String, Integer, Text, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import json

# SQLite database file
DATABASE_URL = "sqlite:///./disk_intelligence.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# ============================================================================
# Database Models
# ============================================================================

class SnapshotDB(Base):
    """Database model for scan snapshots."""
    __tablename__ = "snapshots"

    id = Column(String, primary_key=True, index=True)
    scan_id = Column(String, nullable=False)
    root_path = Column(String, nullable=False, index=True)
    findings_json = Column(Text, nullable=False)  # JSON serialized findings
    extensions_json = Column(Text, nullable=False)  # JSON serialized extensions
    scan_info_json = Column(Text, nullable=False)  # JSON serialized scan info
    saved_at = Column(DateTime, default=datetime.utcnow)

    # Metadata fields for quick display
    total_files = Column(Integer)
    total_folders = Column(Integer)
    total_size_bytes = Column(Integer)

# Create tables
Base.metadata.create_all(bind=engine)

# ============================================================================
# Database helper functions
# ============================================================================

def get_db():
    """Get database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def serialize_snapshot(
    snapshot_id: str,
    scan_id: str,
    root_path: str,
    findings: list,
    extensions: list,
    scan_info: dict
) -> SnapshotDB:
    """Create a SnapshotDB instance from scan data."""
    return SnapshotDB(
        id=snapshot_id,
        scan_id=scan_id,
        root_path=root_path,
        findings_json=json.dumps([f.dict() if hasattr(f, 'dict') else f for f in findings]),
        extensions_json=json.dumps([e.dict() if hasattr(e, 'dict') else e for e in extensions]),
        scan_info_json=json.dumps(scan_info.dict() if hasattr(scan_info, 'dict') else scan_info),
        total_files=scan_info.get('total_files') if isinstance(scan_info, dict) else scan_info.total_files,
        total_folders=scan_info.get('total_folders') if isinstance(scan_info, dict) else scan_info.total_folders,
        total_size_bytes=scan_info.get('total_size_bytes') if isinstance(scan_info, dict) else scan_info.total_size_bytes,
        saved_at=datetime.utcnow()
    )

def deserialize_snapshot(snapshot_db: SnapshotDB) -> dict:
    """Convert SnapshotDB to a dictionary for API response."""
    return {
        "id": snapshot_db.id,
        "scan_id": snapshot_db.scan_id,
        "root_path": snapshot_db.root_path,
        "findings": json.loads(snapshot_db.findings_json),
        "extensions": json.loads(snapshot_db.extensions_json),
        "scan_info": json.loads(snapshot_db.scan_info_json),
        "saved_at": snapshot_db.saved_at.isoformat(),
        "total_files": snapshot_db.total_files,
        "total_folders": snapshot_db.total_folders,
        "total_size_bytes": snapshot_db.total_size_bytes,
    }
