const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function extractYouTubeId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (YOUTUBE_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0];
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) id = parts[1];
    }
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

async function fetchYouTubeMetadata(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { 'User-Agent': 'VideoEvaluationWeb/2.0' }
    });
    if (!response.ok) throw new Error('YouTube에서 영상을 확인할 수 없습니다. 일부공개 상태와 링크를 확인하세요.');
    const data = await response.json();
    return {
      title: String(data.title || '').trim(),
      authorName: String(data.author_name || '').trim(),
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      watchUrl
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('YouTube 확인 시간이 초과되었습니다. 다시 시도하세요.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractYouTubeId, fetchYouTubeMetadata };
