-- ReplyPilot / AI Reply AI usage and cost log.
-- Safe to re-run: every table/index is guarded with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  feature TEXT,
  case_id TEXT,
  event_id TEXT,
  intent TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  data TEXT
);

CREATE INDEX IF NOT EXISTS ai_usage_project_created_idx
ON ai_usage_logs (project_key, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_usage_project_feature_created_idx
ON ai_usage_logs (project_key, feature, created_at DESC);
