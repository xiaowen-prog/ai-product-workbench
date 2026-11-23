from __future__ import annotations

import os
import tempfile
from pathlib import Path


def pytest_configure() -> None:
    """Keep teacher-agent test state outside the user's project data directory."""
    root = Path(tempfile.mkdtemp(prefix="ai-product-factory-tests-"))
    os.environ.setdefault("AGENT_DATA_DIR", str(root / "agent-data"))
    os.environ.setdefault("AGENT_DB_PATH", str(root / "agent-data" / "agent_workbench.sqlite3"))
    os.environ.setdefault("AI_WORKBENCH_DATA_DIR", str(root / "workbench-data"))
