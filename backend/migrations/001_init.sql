-- Autonomous Agent Workbench CloudBase PostgreSQL schema.
-- Run once before DATA_BACKEND=cloudbase_rest. Keep the prefix in sync with
-- CLOUDBASE_TABLE_PREFIX (default: agent_workbench_).
-- The API key is server-side only. RLS is enabled without browser policies.

CREATE TABLE IF NOT EXISTS agent_workbench_tasks (
    id VARCHAR(36) PRIMARY KEY,
    owner_id VARCHAR(128) NOT NULL,
    title VARCHAR(200) NOT NULL,
    brief TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'draft',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_tasks_owner_id ON agent_workbench_tasks(owner_id);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_tasks_status ON agent_workbench_tasks(status);

CREATE TABLE IF NOT EXISTS agent_workbench_task_events (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_task_events_task_id ON agent_workbench_task_events(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_workbench_task_events_task_sequence ON agent_workbench_task_events(task_id, sequence);

CREATE TABLE IF NOT EXISTS agent_workbench_todos (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued'
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_todos_task_id ON agent_workbench_todos(task_id);

CREATE TABLE IF NOT EXISTS agent_workbench_artifacts (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    path TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ready',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_artifacts_task_id ON agent_workbench_artifacts(task_id);

CREATE TABLE IF NOT EXISTS agent_workbench_tool_definitions (
    name VARCHAR(64) PRIMARY KEY,
    description TEXT NOT NULL,
    permission VARCHAR(16) NOT NULL DEFAULT 'allow',
    arguments_json TEXT NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_workbench_tool_calls (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    tool_name VARCHAR(64) NOT NULL,
    permission VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    error_code VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_tool_calls_task_id ON agent_workbench_tool_calls(task_id);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_tool_calls_tool_name ON agent_workbench_tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_tool_calls_status ON agent_workbench_tool_calls(status);

CREATE TABLE IF NOT EXISTS agent_workbench_knowledge_entries (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source VARCHAR(200) NOT NULL DEFAULT 'local',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_workbench_jobs (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    kind VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    mode VARCHAR(32) NOT NULL DEFAULT 'success',
    timeout_seconds DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_jobs_task_id ON agent_workbench_jobs(task_id);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_jobs_status ON agent_workbench_jobs(status);

CREATE TABLE IF NOT EXISTS agent_workbench_agent_runs (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_tasks(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 1,
    max_steps INTEGER NOT NULL DEFAULT 5,
    max_retries INTEGER NOT NULL DEFAULT 2,
    failure_mode VARCHAR(32) NOT NULL DEFAULT 'none',
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'mock',
    provider VARCHAR(64),
    model VARCHAR(128),
    pause_after_step INTEGER,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_agent_runs_task_id ON agent_workbench_agent_runs(task_id);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_agent_runs_status ON agent_workbench_agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_workbench_agent_steps (
    id VARCHAR(36) PRIMARY KEY,
    run_id VARCHAR(36) NOT NULL REFERENCES agent_workbench_agent_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error_code VARCHAR(64),
    result_json TEXT NOT NULL DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_agent_steps_run_id ON agent_workbench_agent_steps(run_id);
CREATE INDEX IF NOT EXISTS ix_agent_workbench_agent_steps_status ON agent_workbench_agent_steps(status);

ALTER TABLE agent_workbench_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workbench_agent_steps ENABLE ROW LEVEL SECURITY;
