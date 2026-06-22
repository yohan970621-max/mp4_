ALTER TABLE watch_sessions
  ADD COLUMN accumulated_seconds NUMERIC(14,3) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS watch_totals (
  viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  cumulative_seconds NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (cumulative_seconds >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_totals_video ON watch_totals(video_id);

-- v2.0에서 이미 기록된 고유 시청초를 최초 누적값으로 보존합니다.
INSERT INTO watch_totals(viewer_id, video_id, cumulative_seconds)
SELECT viewer_id, video_id, COUNT(*)::numeric
FROM watched_seconds
GROUP BY viewer_id, video_id
ON CONFLICT (viewer_id, video_id) DO NOTHING;

INSERT INTO settings(key, value)
VALUES ('ranking_mode', 'composite')
ON CONFLICT (key) DO UPDATE SET value = 'composite', updated_at = NOW();
