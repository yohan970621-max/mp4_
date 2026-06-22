CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_lookup TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  youtube_id VARCHAR(32) NOT NULL UNIQUE,
  youtube_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS display_orders (
  viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_display_orders_viewer_position ON display_orders(viewer_id, position);

CREATE TABLE IF NOT EXISTS watch_sessions (
  id BIGSERIAL PRIMARY KEY,
  viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_position NUMERIC(10,3) NOT NULL DEFAULT 0,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_viewer_video ON watch_sessions(viewer_id, video_id);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_video ON watch_sessions(video_id);

CREATE TABLE IF NOT EXISTS watched_seconds (
  viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  second_position INTEGER NOT NULL CHECK (second_position >= 0),
  first_watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, video_id, second_position)
);
CREATE INDEX IF NOT EXISTS idx_watched_seconds_video ON watched_seconds(video_id);

CREATE TABLE IF NOT EXISTS watch_events (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES watch_sessions(id) ON DELETE CASCADE,
  viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  position NUMERIC(10,3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watch_events_session ON watch_events(session_id);

INSERT INTO settings(key, value) VALUES
  ('event_title', '영상 편집 개인작업 시청 평가'),
  ('submission_open', '1'),
  ('evaluation_open', '0'),
  ('min_valid_seconds', '10'),
  ('ranking_mode', 'watch_time'),
  ('anonymous_mode', '1')
ON CONFLICT (key) DO NOTHING;
