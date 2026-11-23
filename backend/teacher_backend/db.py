from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from teacher_backend.core.config import ARTIFACT_ROOT, DB_PATH, DATA_ROOT, validate_storage_settings


class Base(DeclarativeBase):
    pass


DATA_ROOT.mkdir(parents=True, exist_ok=True)
ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def init_db() -> None:
    storage = validate_storage_settings()
    if storage.is_cloudbase:
        # CloudRun instances still need a local ORM session because the existing
        # services operate on SQLAlchemy models. The cache is hydrated from the
        # durable CloudBase REST tables before serving requests.
        from teacher_backend.services.cloudbase_rest import hydrate_session_database, init_client, install_session_sync

        init_client(storage)
        install_session_sync()
        from teacher_backend.models import AgentRun, AgentStep, Artifact, Job, KnowledgeEntry, Task, TaskEvent, ToolCall, ToolDefinition, Todo  # noqa: F401

        Base.metadata.create_all(bind=engine)
        _migrate_agent_run_columns()
        hydrate_session_database(engine)
        from teacher_backend.services.catalog import seed_catalog
        from teacher_backend.services.knowledge import seed_knowledge

        with SessionLocal() as session:
            seed_catalog(session)
            seed_knowledge(session)
        return
    from teacher_backend.models import AgentRun, AgentStep, Artifact, Job, KnowledgeEntry, Task, TaskEvent, ToolCall, ToolDefinition, Todo  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_agent_run_columns()
    from teacher_backend.services.catalog import seed_catalog
    from teacher_backend.services.knowledge import seed_knowledge

    with SessionLocal() as session:
        seed_catalog(session)
        seed_knowledge(session)


def _migrate_agent_run_columns() -> None:
    """Add model-run metadata columns for databases created before stage 4.

    The project uses SQLite for the local/recoverable backend, so a tiny
    idempotent migration keeps existing task history readable without a
    migration dependency.  New databases still receive the columns through
    SQLAlchemy metadata.
    """

    columns = {column["name"] for column in inspect(engine).get_columns("agent_runs")}
    additions = {
        "execution_mode": "VARCHAR(16) NOT NULL DEFAULT 'mock'",
        "provider": "VARCHAR(64)",
        "model": "VARCHAR(128)",
    }
    missing = [(name, definition) for name, definition in additions.items() if name not in columns]
    if not missing:
        return
    with engine.begin() as connection:
        for name, definition in missing:
            connection.execute(text(f"ALTER TABLE agent_runs ADD COLUMN {name} {definition}"))


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
