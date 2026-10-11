CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'account')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_sessions_principal_idx ON auth_sessions(principal_id);

CREATE TABLE IF NOT EXISTS preferences (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  era TEXT NOT NULL DEFAULT 'all' CHECK (era IN ('all', '1970s', '1980s', '1990s', '2000s')),
  category TEXT NOT NULL DEFAULT 'all' CHECK (category IN ('all', 'news', 'storytelling', 'novel', 'opera')),
  tuning_sound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  analytics_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  login_identity TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'reviewer', 'admin')),
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  bytes BIGINT,
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms > 0),
  checksum TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  era TEXT NOT NULL CHECK (era IN ('1970s', '1980s', '1990s', '2000s')),
  category TEXT NOT NULL CHECK (category IN ('news', 'storytelling', 'novel', 'opera')),
  audio_asset_id TEXT NOT NULL REFERENCES audio_assets(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('archive_original', 'modern_performance', 'ai_reconstruction')),
  event_year INTEGER,
  work_year INTEGER,
  recording_year INTEGER,
  era_basis TEXT NOT NULL,
  source_note TEXT NOT NULL,
  is_excerpt BOOLEAN NOT NULL DEFAULT FALSE,
  excerpt_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'published', 'offline')),
  starter_pool BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS programs_public_idx ON programs(status, era, category);

CREATE TABLE IF NOT EXISTS program_sources (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS program_clearances (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  usage_basis TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  checked_by TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS program_reviews (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  script_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  notes TEXT,
  reviewer_id TEXT NOT NULL REFERENCES admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_summary TEXT,
  after_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listening_sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_source TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'development',
  analytics_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS listening_sessions_principal_idx ON listening_sessions(principal_id, started_at);

CREATE TABLE IF NOT EXISTS queues (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  session_id TEXT NOT NULL REFERENCES listening_sessions(id),
  era TEXT NOT NULL CHECK (era IN ('all', '1970s', '1980s', '1990s', '2000s')),
  category TEXT NOT NULL CHECK (category IN ('all', 'news', 'storytelling', 'novel', 'opera')),
  round_no INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  last_program_id TEXT REFERENCES programs(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_items (
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  position INTEGER NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs(id),
  PRIMARY KEY (queue_id, round_no, position)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_id, scope, request_id)
);

CREATE TABLE IF NOT EXISTS queue_requests (
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (queue_id, request_id)
);

CREATE TABLE IF NOT EXISTS playbacks (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  session_id TEXT NOT NULL REFERENCES listening_sessions(id),
  queue_id TEXT REFERENCES queues(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  era_snapshot TEXT NOT NULL,
  category_snapshot TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  max_seq INTEGER NOT NULL DEFAULT 0,
  listen_ms BIGINT NOT NULL DEFAULT 0,
  observed_wall_ms BIGINT NOT NULL DEFAULT 0,
  last_position_ms BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS playbacks_principal_idx ON playbacks(principal_id, started_at);

CREATE TABLE IF NOT EXISTS playback_day_totals (
  playback_id TEXT NOT NULL REFERENCES playbacks(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  listen_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (playback_id, business_date)
);

CREATE TABLE IF NOT EXISTS play_attempts (
  id TEXT PRIMARY KEY,
  playback_id TEXT NOT NULL REFERENCES playbacks(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('user', 'autonext', 'retry')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'blocked', 'error')),
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  session_id TEXT NOT NULL REFERENCES listening_sessions(id),
  playback_id TEXT REFERENCES playbacks(id),
  attempt_id TEXT REFERENCES play_attempts(id),
  name TEXT NOT NULL,
  client_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS analytics_events_name_received_idx ON analytics_events(name, received_at);

CREATE TABLE IF NOT EXISTS likes (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_id, program_id)
);

CREATE TABLE IF NOT EXISTS feedback_prompts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  session_id TEXT NOT NULL REFERENCES listening_sessions(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  playback_id TEXT NOT NULL REFERENCES playbacks(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('ended', 'long_listen')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shown_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_one_per_session_idx ON feedback_prompts(session_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  playback_id TEXT NOT NULL REFERENCES playbacks(id),
  prompt_id TEXT NOT NULL REFERENCES feedback_prompts(id),
  answer TEXT NOT NULL CHECK (answer IN ('like', 'neutral')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(principal_id, prompt_id)
);

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
