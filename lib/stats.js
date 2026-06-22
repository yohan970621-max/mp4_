const { query } = require('../db');

async function getRanking(settings = {}) {
  const minValid = Math.max(1, Number(settings.min_valid_seconds || 10));
  const mode = settings.ranking_mode === 'watch_rate' ? 'watch_rate' : 'watch_time';
  const evaluators = (await query(`SELECT id FROM users WHERE active = TRUE AND role IN ('student','teacher')`)).rows.map((row) => Number(row.id));
  const videos = (await query(`
    SELECT v.id, v.owner_id, v.title, v.youtube_id, v.thumbnail_url, v.duration_seconds,
           owner.name AS owner_name, owner.active AS owner_active, owner.role AS owner_role
    FROM videos v JOIN users owner ON owner.id = v.owner_id
    WHERE v.active = TRUE ORDER BY v.id
  `)).rows;
  const watchedRows = (await query(`
    SELECT viewer_id, video_id, COUNT(*)::int AS watched_seconds
    FROM watched_seconds GROUP BY viewer_id, video_id
  `)).rows;
  const clickRows = (await query(`
    SELECT viewer_id, video_id, COUNT(*)::int AS click_count
    FROM watch_sessions GROUP BY viewer_id, video_id
  `)).rows;
  const evaluatorSet = new Set(evaluators);
  const watchedByVideo = new Map();
  for (const row of watchedRows) {
    const viewerId = Number(row.viewer_id);
    if (!evaluatorSet.has(viewerId)) continue;
    const videoId = Number(row.video_id);
    if (!watchedByVideo.has(videoId)) watchedByVideo.set(videoId, []);
    watchedByVideo.get(videoId).push({ viewerId, seconds: Number(row.watched_seconds) || 0 });
  }
  const clicksByVideo = new Map();
  for (const row of clickRows) {
    const viewerId = Number(row.viewer_id);
    if (!evaluatorSet.has(viewerId)) continue;
    const videoId = Number(row.video_id);
    if (!clicksByVideo.has(videoId)) clicksByVideo.set(videoId, []);
    clicksByVideo.get(videoId).push({ viewerId, count: Number(row.click_count) || 0 });
  }
  const rows = videos.map((video) => {
    const ownerId = Number(video.owner_id);
    const duration = Number(video.duration_seconds) || 0;
    const ownerIsEvaluator = video.owner_active && ['student', 'teacher'].includes(video.owner_role);
    const eligible = Math.max(0, evaluators.length - (ownerIsEvaluator ? 1 : 0));
    const watched = (watchedByVideo.get(Number(video.id)) || [])
      .filter((row) => row.viewerId !== ownerId)
      .map((row) => ({ ...row, seconds: duration > 0 ? Math.min(row.seconds, duration) : row.seconds }));
    const validWatched = watched.filter((row) => row.seconds >= minValid);
    const clicks = (clicksByVideo.get(Number(video.id)) || []).filter((row) => row.viewerId !== ownerId);
    const total = validWatched.reduce((sum, row) => sum + row.seconds, 0);
    const valid = validWatched.length;
    const completion = duration > 0 ? validWatched.filter((row) => row.seconds >= duration * 0.9).length : 0;
    const clickedViewers = new Set(clicks.map((row) => row.viewerId)).size;
    const totalClicks = clicks.reduce((sum, row) => sum + row.count, 0);
    const averageAll = eligible > 0 ? total / eligible : 0;
    const averageClicker = valid > 0 ? total / valid : 0;
    const averageRate = duration > 0 && eligible > 0 ? Math.min(100, total / (duration * eligible) * 100) : 0;
    return {
      ...video,
      id: Number(video.id), owner_id: ownerId, duration_seconds: duration,
      eligible_count: eligible, total_watch_seconds: total, valid_viewers: valid,
      completion_count: completion, total_clicks: totalClicks, clicked_viewers: clickedViewers,
      average_all_seconds: averageAll, average_clicker_seconds: averageClicker,
      average_watch_rate: averageRate,
      click_rate: eligible > 0 ? clickedViewers / eligible * 100 : 0,
      completion_rate: valid > 0 ? completion / valid * 100 : 0
    };
  });
  rows.sort((a, b) => {
    const primaryA = mode === 'watch_rate' ? a.average_watch_rate : a.average_all_seconds;
    const primaryB = mode === 'watch_rate' ? b.average_watch_rate : b.average_all_seconds;
    return primaryB - primaryA || b.valid_viewers - a.valid_viewers || b.completion_count - a.completion_count || a.id - b.id;
  });
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

async function getViewerMatrix() {
  const users = (await query(`SELECT id, name, role FROM users WHERE active = TRUE AND role IN ('student','teacher') ORDER BY role DESC, id`)).rows;
  const videos = (await query(`
    SELECT v.id, v.owner_id, v.title, u.name AS owner_name, v.duration_seconds
    FROM videos v JOIN users u ON u.id = v.owner_id
    WHERE v.active = TRUE ORDER BY v.id
  `)).rows;
  const watched = (await query(`SELECT viewer_id, video_id, COUNT(*)::int AS seconds FROM watched_seconds GROUP BY viewer_id, video_id`)).rows;
  const map = new Map(watched.map((row) => [`${row.viewer_id}:${row.video_id}`, Number(row.seconds)]));
  return { users, videos, getSeconds: (viewerId, videoId) => map.get(`${viewerId}:${videoId}`) || 0 };
}

async function getVideoViewerRows(videoId) {
  const result = await query(`
    WITH watched AS (
      SELECT viewer_id, COUNT(*)::int AS watched_seconds
      FROM watched_seconds WHERE video_id = $1 GROUP BY viewer_id
    ), clicks AS (
      SELECT viewer_id, COUNT(*)::int AS click_count
      FROM watch_sessions WHERE video_id = $1 GROUP BY viewer_id
    )
    SELECT u.id, u.name, u.role,
      COALESCE(w.watched_seconds, 0)::int AS watched_seconds,
      COALESCE(c.click_count, 0)::int AS click_count
    FROM users u
    LEFT JOIN watched w ON w.viewer_id = u.id
    LEFT JOIN clicks c ON c.viewer_id = u.id
    WHERE u.active = TRUE AND u.role IN ('student','teacher')
      AND u.id <> (SELECT owner_id FROM videos WHERE id = $1)
    ORDER BY watched_seconds DESC, u.id
  `, [videoId]);
  return result.rows;
}

async function getViewerVideoRows(viewerId) {
  const result = await query(`
    WITH watched AS (
      SELECT video_id, COUNT(*)::int AS watched_seconds
      FROM watched_seconds WHERE viewer_id = $1 GROUP BY video_id
    ), clicks AS (
      SELECT video_id, COUNT(*)::int AS click_count
      FROM watch_sessions WHERE viewer_id = $1 GROUP BY video_id
    )
    SELECT v.id, v.owner_id, v.title, v.duration_seconds, owner.name AS owner_name,
      COALESCE(w.watched_seconds, 0)::int AS watched_seconds,
      COALESCE(c.click_count, 0)::int AS click_count
    FROM videos v
    JOIN users owner ON owner.id = v.owner_id
    LEFT JOIN watched w ON w.video_id = v.id
    LEFT JOIN clicks c ON c.video_id = v.id
    WHERE v.active = TRUE AND v.owner_id <> $1
    ORDER BY watched_seconds DESC, v.id
  `, [viewerId]);
  return result.rows;
}

module.exports = { getRanking, getViewerMatrix, getVideoViewerRows, getViewerVideoRows };
