-- Moderation tables für ehoser
-- In Supabase > SQL Editor ausführen

ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NULL;

CREATE TABLE IF NOT EXISTS chat_reports (
  id BIGSERIAL PRIMARY KEY,
  group_id UUID NOT NULL,
  group_name TEXT,
  reported_by TEXT NOT NULL,
  target_username TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  messages JSONB DEFAULT '[]'::jsonb,
  action_type TEXT,
  action_description TEXT,
  action_by TEXT,
  action_at TIMESTAMP,
  ban_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT,
  username TEXT NOT NULL,
  action_type TEXT NOT NULL,
  duration_hours INTEGER,
  reason TEXT,
  action_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
