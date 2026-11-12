CREATE TABLE IF NOT EXISTS subagent_completions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  parent_run_id TEXT,
  notification_message_id TEXT,
  delivery_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id, execution_id)
);
CREATE INDEX IF NOT EXISTS idx_subagent_completions_recovery
  ON subagent_completions(conversation_id, status, created_at);
