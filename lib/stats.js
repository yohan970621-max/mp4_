const { query } = require('../db');
const { applyCompositeScores } = require('./scoring');

async function getRanking(settings = {}) {
  const minValid = Math.max(1, Number(settings.min_valid_seconds || 10));
  const evaluators = (await query(
    `SELECT id FROM users WHERE active = TRUE AND role IN ('student','teacher')`
  )).rows.map((row) => Number(row.id));

  const videos = (await query(`
    SELECT v.id, v.owner_id, v.title, v.youtube_id, v.thumbnail_url, v.duration_seconds,
           owner.name AS owner_name, owner.active AS owner_active, owner.role AS owner_role
    FROM videos v
    JOIN users owner ON owner.id = v.owner_id
    WHERE v.active = TRUE
    ORDER BY v.id
  `)).rows;

  const watchRows = (await query(`
    SELECT viewer_id, video_id, cumulative_seconds
    FROM watch_totals
  `)).rows;

  const clickRows = (await query(`
    SELECT viewer_id, video_id, COUNT(*)::int AS click_count
    FROM watch_sessions
    GROUP BY viewer_id, video_id
  `)).rows;

  const evaluatorSet = new Set(evaluators);
  const watchedByVideo = new Map();
  for (const row of watchRows) {
    const viewerId = Number(row.viewer_id);
    if (!evaluatorSet.has(viewerId)) continue;
    const videoId = Number(row.video_id);
    if (!watchedByVideo.has(videoId)) watchedByVideo.set(videoId, []);
    watchedByVideo.get(videoId).push({
      viewerId,
      seconds: Math.max(0, Number(row.cumulative_seconds) || 0)
    });
  }

  const clicksByVideo = new Map();
  for (const row of clickRows) {
    const viewerId = Number(row.viewer_id);
    if (!evaluatorSet.has(viewerId)) continue;
    const videoId = Number(row.video_id);
    if (!clicksByVideo.has(videoId)) clicksByVideo.set(videoId, []);
    clicksByVideo.get(videoId).push({
      viewerId,
      count: Number(row.click_count) || 0
    });
  }

  const rows = videos.map((video) => {
    const id = Number(video.id);
    const ownerId = Number(video.owner_id);
    const duration = Number(video.duration_seconds) || 0;
    const ownerIsEvaluator = video.owner_active && ['student', 'teacher'].includes(video.owner_role);
    const eligible = Math.max(0, evaluators.length - (ownerIsEvaluator ? 1 : 0));

    const watched = (watchedByVideo.get(id) || []).filter((row) => row.viewerId !== ownerId);
    const clicks = (clicksByVideo.get(id) || []).filter((row) => row.viewerId !== ownerId);
    const clickedViewerIds = new Set(clicks.map((row) => row.viewerId));

    const totalWatchSeconds = watched.reduce((sum, row) => sum + row.seconds, 0);
    const clickedViewers = clickedViewerIds.size;
    const totalClicks = clicks.reduce((sum, row) => sum + row.count, 0);
    const validViewers = watched.filter((row) => row.seconds >= minValid).length;

    // 반복 재생과 재시청을 모두 포함한 누적 시청시간을 클릭한 고유 평가자 수로 나눕니다.
    const averageWatchSeconds = clickedViewers > 0 ? totalWatchSeconds / clickedViewers : 0;
    // YouTube식 누적 비율: 반복 재생이 많으면 100%를 넘을 수 있습니다.
    const averageRetentionRate = duration > 0 ? (averageWatchSeconds / duration) * 100 : 0;
    const clickRate = eligible > 0 ? (clickedViewers / eligible) * 100 : 0;

    return {
      ...video,
      id,
      owner_id: ownerId,
      duration_seconds: duration,
      eligible_count: eligible,
      total_watch_seconds: totalWatchSeconds,
      total_clicks: totalClicks,
      clicked_viewers: clickedViewers,
      valid_viewers: validViewers,
      average_watch_seconds: averageWatchSeconds,
      average_retention_rate: averageRetentionRate,
      click_rate: clickRate,
      // 이전 화면/외부 연동과의 호환용 값
      average_all_seconds: eligible > 0 ? totalWatchSeconds / eligible : 0,
      average_clicker_seconds: averageWatchSeconds,
      average_watch_rate: averageRetentionRate
    };
  });

  applyCompositeScores(rows);
  return rows;
}

async function getViewerMatrix() {
  const users = (await query(`
    SELECT id, name, role
    FROM users
    WHERE active = TRUE AND role IN ('student','teacher')
    ORDER BY role DESC, id
  `)).rows;
  const videos = (await query(`
    SELECT v.id, v.owner_id, v.title, u.name AS owner_name, v.duration_seconds
    FROM videos v
    JOIN users u ON u.id = v.owner_id
    WHERE v.active = TRUE
    ORDER BY v.id
  `)).rows;
  const watched = (await query(`
    SELECT viewer_id, video_id, cumulative_seconds AS seconds
    FROM watch_totals
  `)).rows;
  const map = new Map(watched.map((row) => [
    `${row.viewer_id}:${row.video_id}`,
    Number(row.seconds) || 0
  ]));
  return {
    users,
    videos,
    getSeconds: (viewerId, videoId) => map.get(`${viewerId}:${videoId}`) || 0
  };
}

async function getVideoViewerRows(videoId) {
  const result = await query(`
    WITH watched AS (
      SELECT viewer_id, cumulative_seconds AS watched_seconds
      FROM watch_totals
      WHERE video_id = $1
    ), clicks AS (
      SELECT viewer_id, COUNT(*)::int AS click_count
      FROM watch_sessions
      WHERE video_id = $1
      GROUP BY viewer_id
    )
    SELECT u.id, u.name, u.role,
      COALESCE(w.watched_seconds, 0) AS watched_seconds,
      COALESCE(c.click_count, 0)::int AS click_count
    FROM users u
    LEFT JOIN watched w ON w.viewer_id = u.id
    LEFT JOIN clicks c ON c.viewer_id = u.id
    WHERE u.active = TRUE
      AND u.role IN ('student','teacher')
      AND u.id <> (SELECT owner_id FROM videos WHERE id = $1)
    ORDER BY watched_seconds DESC, u.id
  `, [videoId]);
  return result.rows.map((row) => ({ ...row, watched_seconds: Number(row.watched_seconds) || 0 }));
}

async function getViewerVideoRows(viewerId) {
  const result = await query(`
    WITH watched AS (
      SELECT video_id, cumulative_seconds AS watched_seconds
      FROM watch_totals
      WHERE viewer_id = $1
    ), clicks AS (
      SELECT video_id, COUNT(*)::int AS click_count
      FROM watch_sessions
      WHERE viewer_id = $1
      GROUP BY video_id
    )
    SELECT v.id, v.owner_id, v.title, v.duration_seconds, owner.name AS owner_name,
      COALESCE(w.watched_seconds, 0) AS watched_seconds,
      COALESCE(c.click_count, 0)::int AS click_count
    FROM videos v
    JOIN users owner ON owner.id = v.owner_id
    LEFT JOIN watched w ON w.video_id = v.id
    LEFT JOIN clicks c ON c.video_id = v.id
    WHERE v.active = TRUE AND v.owner_id <> $1
    ORDER BY watched_seconds DESC, v.id
  `, [viewerId]);
  return result.rows.map((row) => ({ ...row, watched_seconds: Number(row.watched_seconds) || 0 }));
}

module.exports = { getRanking, getViewerMatrix, getVideoViewerRows, getViewerVideoRows };
