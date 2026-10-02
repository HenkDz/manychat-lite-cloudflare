-- Small JSON documents managed from the dashboard, such as DM tool settings
-- and the conversation starter publication state.
CREATE TABLE IF NOT EXISTS automation_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
