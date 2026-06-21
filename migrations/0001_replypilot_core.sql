-- ReplyPilot / AI Reply core D1 schema.
-- Safe to re-run: every table/index is guarded with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS approvals_project_updated_idx
ON approvals (project_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS approvals_status_updated_idx
ON approvals (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_configs (
  project_key TEXT PRIMARY KEY,
  updated_at TEXT,
  updated_by TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_capi_debug (
  id TEXT PRIMARY KEY,
  updated_at TEXT,
  source TEXT,
  event_key TEXT,
  event_name TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_key TEXT PRIMARY KEY,
  project_name TEXT,
  provider TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  provider TEXT,
  external_contact_id TEXT,
  display_name TEXT,
  phone TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL,
  data TEXT,
  UNIQUE(project_key, provider, external_contact_id)
);

CREATE INDEX IF NOT EXISTS customers_project_updated_idx
ON customers (project_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  provider TEXT,
  external_thread_id TEXT,
  status TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  updated_at TEXT NOT NULL,
  data TEXT,
  UNIQUE(project_key, provider, external_thread_id)
);

CREATE INDEX IF NOT EXISTS conversations_project_updated_idx
ON conversations (project_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  customer_id TEXT,
  conversation_id TEXT,
  provider TEXT,
  provider_message_id TEXT,
  direction TEXT NOT NULL,
  message_type TEXT,
  message_text TEXT,
  message_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT
);

CREATE INDEX IF NOT EXISTS messages_project_time_idx
ON messages (project_key, message_at DESC);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  customer_id TEXT,
  conversation_id TEXT,
  approval_id TEXT,
  status TEXT NOT NULL,
  category TEXT,
  intent TEXT,
  risk_level TEXT,
  stage TEXT,
  action_type TEXT,
  action_label TEXT,
  customer_message TEXT,
  ai_reply TEXT,
  final_reply TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cases_project_updated_idx
ON cases (project_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS cases_status_updated_idx
ON cases (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS case_events (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  event_at TEXT NOT NULL,
  data TEXT
);

CREATE INDEX IF NOT EXISTS case_events_case_time_idx
ON case_events (case_id, event_at DESC);
