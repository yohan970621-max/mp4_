const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const { pool, query, withTransaction, migrate, getSettings, setSetting } = require('./db');
const { extractYouTubeId, fetchYouTubeMetadata } = require('./lib/youtube');
const { pinLookup, validatePin, findUserByPin, requireLogin, requireRole, requireEvaluator } = require('./lib/auth');
const { formatSeconds, shuffle, parseStudentLines, hashIp, escapeCsv } = require('./lib/helpers');
const { getRanking, getViewerMatrix, getVideoViewerRows, getViewerVideoRows } = require('./lib/stats');
const { calculateAcceptedSeconds } = require('./lib/watch');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const isProduction = process.env.NODE_ENV === 'production';

if (process.env.TRUST_PROXY === '1' || isProduction) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://s.ytimg.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://img.youtube.com'],
      frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1d' : 0 }));

const sessionOptions = {
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'video_eval_sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 12
  }
};
if (process.env.USE_PGMEM !== '1' && process.env.SESSION_STORE !== 'memory') {
  const PgStore = connectPgSimple(session);
  sessionOptions.store = new PgStore({ pool, createTableIfMissing: true, tableName: 'user_sessions' });
}
app.use(session(sessionOptions));

app.use(async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.locals.user = req.session.user || null;
    res.locals.settings = settings;
    res.locals.eventTitle = settings.event_title || '영상 시청 평가';
    res.locals.formatSeconds = formatSeconds;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  } catch (error) {
    next(error);
  }
});

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function isSetupComplete() {
  const result = await query('SELECT COUNT(*)::int AS count FROM users');
  return Number(result.rows[0].count) > 0;
}

async function ensureDisplayOrder(viewerId, ownerId = null) {
  const videosResult = await query(
    `SELECT id FROM videos WHERE active = TRUE ${ownerId ? 'AND owner_id <> $1' : ''} ORDER BY id`,
    ownerId ? [ownerId] : []
  );
  const videoIds = videosResult.rows.map((row) => Number(row.id));
  const existingResult = await query('SELECT video_id, position FROM display_orders WHERE viewer_id = $1 ORDER BY position', [viewerId]);
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.video_id)));
  const missing = shuffle(videoIds.filter((id) => !existingIds.has(id)));
  let position = existingResult.rows.reduce((max, row) => Math.max(max, Number(row.position)), 0);
  if (missing.length) {
    await withTransaction(async (client) => {
      for (const videoId of missing) {
        position += 1;
        await client.query(
          'INSERT INTO display_orders(viewer_id, video_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [viewerId, videoId, position]
        );
      }
    });
  }
}

function safeReturnTo(value, fallback = '/') {
  const text = String(value || '');
  return text.startsWith('/') && !text.startsWith('//') ? text : fallback;
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'
});

app.get('/health', async (req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, version: '2.1.0' });
  } catch (error) { next(error); }
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

app.get('/setup', async (req, res, next) => {
  try {
    if (await isSetupComplete()) return res.redirect('/login');
    const template = Array.from({ length: 21 }, (_, index) => `학생 ${String(index + 1).padStart(2, '0')},${1001 + index}`).join('\n');
    res.render('setup', { template });
  } catch (error) { next(error); }
});

app.post('/setup', async (req, res, next) => {
  try {
    if (await isSetupComplete()) return res.status(403).render('error', { message: '초기 설정은 이미 완료되었습니다.' });
    const eventTitle = String(req.body.eventTitle || '').trim().slice(0, 100);
    const adminName = String(req.body.adminName || '관리자').trim().slice(0, 50);
    const teacherName = String(req.body.teacherName || '강사').trim().slice(0, 50);
    const adminPin = String(req.body.adminPin || '').trim();
    const teacherPin = String(req.body.teacherPin || '').trim();
    const students = parseStudentLines(req.body.students);
    if (!eventTitle || !adminName || !teacherName) throw new Error('행사명과 계정 이름을 입력하세요.');
    if (!validatePin(adminPin) || !validatePin(teacherPin)) throw new Error('PIN은 숫자 4~12자리로 입력하세요.');
    if (students.length < 1 || students.length > 100) throw new Error('학생은 1명 이상 100명 이하로 등록하세요.');
    const allPins = [adminPin, teacherPin, ...students.map((row) => row.pin)];
    if (allPins.some((pin) => !validatePin(pin))) throw new Error('모든 PIN은 숫자 4~12자리여야 합니다.');
    if (new Set(allPins).size !== allPins.length) throw new Error('PIN이 중복되었습니다. 모든 계정에 다른 PIN을 사용하세요.');

    await withTransaction(async (client) => {
      const insertUser = async (name, pin, role) => {
        await client.query(
          `INSERT INTO users(name, pin_hash, pin_lookup, role) VALUES ($1,$2,$3,$4)`,
          [name, await bcrypt.hash(pin, 10), pinLookup(pin), role]
        );
      };
      await insertUser(adminName, adminPin, 'admin');
      await insertUser(teacherName, teacherPin, 'teacher');
      for (const student of students) await insertUser(student.name.slice(0, 50), student.pin, 'student');
      await setSetting('event_title', eventTitle, client);
      await setSetting('submission_open', '1', client);
      await setSetting('evaluation_open', '0', client);
      await setSetting('min_valid_seconds', '10', client);
      await setSetting('ranking_mode', 'composite', client);
      await setSetting('anonymous_mode', '1', client);
    });
    res.redirect('/login?setup=1');
  } catch (error) {
    res.status(400).render('setup', { template: req.body.students || '', error: error.message });
  }
});

app.get('/login', async (req, res, next) => {
  try {
    if (!(await isSetupComplete())) return res.redirect('/setup');
    if (req.session.user) return res.redirect('/');
    res.render('login', { setupDone: req.query.setup === '1' });
  } catch (error) { next(error); }
});

app.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const user = await findUserByPin(req.body.pin);
    if (!user) return res.status(401).render('login', { error: 'PIN이 올바르지 않거나 비활성화된 계정입니다.', setupDone: false });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = { id: Number(user.id), name: user.name, role: user.role };
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect(user.role === 'admin' ? '/admin' : '/videos');
      });
    });
  } catch (error) { next(error); }
});

app.post('/logout', requireLogin, (req, res, next) => {
  req.session.destroy((error) => error ? next(error) : res.redirect('/login'));
});

app.get('/', async (req, res, next) => {
  try {
    if (!(await isSetupComplete())) return res.redirect('/setup');
    if (!req.session.user) return res.redirect('/login');
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/videos');
  } catch (error) { next(error); }
});

app.get('/submit', requireRole('student'), async (req, res, next) => {
  try {
    const settings = res.locals.settings;
    const current = await query('SELECT * FROM videos WHERE owner_id = $1 LIMIT 1', [req.session.user.id]);
    res.render('submit', { current: current.rows[0] || null, submissionOpen: settings.submission_open === '1' && settings.evaluation_open !== '1' });
  } catch (error) { next(error); }
});

app.post('/submit', requireRole('student'), async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.submission_open !== '1' || settings.evaluation_open === '1') throw new Error('현재 작품 제출 기간이 아닙니다.');
    const youtubeId = extractYouTubeId(req.body.youtubeUrl);
    if (!youtubeId) throw new Error('올바른 YouTube 주소를 입력하세요.');
    const metadata = await fetchYouTubeMetadata(youtubeId);
    const title = String(req.body.title || metadata.title || '제목 없음').trim().slice(0, 120);
    if (!title) throw new Error('작품 제목을 입력하세요.');

    await query(`
      INSERT INTO videos(owner_id, title, youtube_id, youtube_url, thumbnail_url, active, updated_at)
      VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
      ON CONFLICT (owner_id) DO UPDATE SET
        title = EXCLUDED.title,
        youtube_id = EXCLUDED.youtube_id,
        youtube_url = EXCLUDED.youtube_url,
        thumbnail_url = EXCLUDED.thumbnail_url,
        duration_seconds = 0,
        active = TRUE,
        updated_at = NOW()
    `, [req.session.user.id, title, youtubeId, metadata.watchUrl, metadata.thumbnailUrl]);
    await query('DELETE FROM display_orders WHERE video_id = (SELECT id FROM videos WHERE owner_id = $1)', [req.session.user.id]);
    flash(req, 'success', '작품 링크가 저장되었습니다. 아래 미리보기에서 재생되는지 확인하세요.');
    res.redirect('/submit');
  } catch (error) {
    if (error.code === '23505') error.message = '이미 다른 학생이 제출한 YouTube 영상입니다.';
    flash(req, 'error', error.message);
    res.redirect('/submit');
  }
});

app.get('/videos', requireEvaluator, async (req, res, next) => {
  try {
    const settings = res.locals.settings;
    const user = req.session.user;
    await ensureDisplayOrder(user.id, user.role === 'student' ? user.id : null);
    const result = await query(`
      SELECT v.id, v.owner_id, v.title, v.youtube_id, v.thumbnail_url, v.duration_seconds,
        u.name AS owner_name, d.position,
        COALESCE(w.watched_seconds, 0) AS watched_seconds,
        COALESCE(c.click_count, 0)::int AS click_count
      FROM display_orders d
      JOIN videos v ON v.id = d.video_id AND v.active = TRUE
      JOIN users u ON u.id = v.owner_id
      LEFT JOIN (
        SELECT video_id, cumulative_seconds AS watched_seconds
        FROM watch_totals WHERE viewer_id = $1
      ) w ON w.video_id = v.id
      LEFT JOIN (
        SELECT video_id, COUNT(*)::int AS click_count
        FROM watch_sessions WHERE viewer_id = $1 GROUP BY video_id
      ) c ON c.video_id = v.id
      WHERE d.viewer_id = $1 ${user.role === 'student' ? 'AND v.owner_id <> $1' : ''}
      ORDER BY d.position
    `, [user.id]);
    let submission = null;
    if (user.role === 'student') {
      const own = await query('SELECT id, title, youtube_id FROM videos WHERE owner_id = $1 AND active = TRUE', [user.id]);
      submission = own.rows[0] || null;
    }
    res.render('videos', { videos: result.rows, submission });
  } catch (error) { next(error); }
});

app.get('/watch/:id', requireEvaluator, async (req, res, next) => {
  try {
    if (res.locals.settings.evaluation_open !== '1') return res.status(403).render('error', { message: '현재 평가가 진행 중이 아닙니다.' });
    const result = await query(`
      SELECT v.*, u.name AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id
      WHERE v.id = $1 AND v.active = TRUE
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).render('error', { message: '작품을 찾을 수 없습니다.' });
    const video = result.rows[0];
    if (req.session.user.role === 'student' && Number(video.owner_id) === req.session.user.id) {
      return res.status(403).render('error', { message: '본인 작품은 평가할 수 없습니다.' });
    }
    res.render('watch', { video });
  } catch (error) { next(error); }
});

app.post('/api/watch/start', requireEvaluator, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.evaluation_open !== '1') return res.status(403).json({ error: '평가가 종료되었습니다.' });
    const videoId = Number(req.body.videoId);
    const videoResult = await query('SELECT id, owner_id FROM videos WHERE id = $1 AND active = TRUE', [videoId]);
    if (!videoResult.rowCount) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    if (req.session.user.role === 'student' && Number(videoResult.rows[0].owner_id) === req.session.user.id) {
      return res.status(403).json({ error: '본인 작품은 평가할 수 없습니다.' });
    }
    const result = await query(`
      INSERT INTO watch_sessions(viewer_id, video_id, user_agent, ip_hash)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [req.session.user.id, videoId, String(req.headers['user-agent'] || '').slice(0, 500), hashIp(req.ip, sessionSecret)]);
    res.json({ sessionId: Number(result.rows[0].id) });
  } catch (error) { next(error); }
});

app.post('/api/watch/heartbeat', requireEvaluator, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.evaluation_open !== '1') return res.status(403).json({ error: '평가가 종료되었습니다.' });

    const sessionId = Number(req.body.sessionId);
    const videoId = Number(req.body.videoId);
    const from = Number(req.body.from);
    const to = Number(req.body.to);
    const duration = Number(req.body.duration || 0);
    const playbackRate = Number(req.body.playbackRate);
    const visible = req.body.visible === true;
    const playing = req.body.playing === true;

    if (![sessionId, videoId, from, to, playbackRate].every(Number.isFinite)) {
      return res.status(400).json({ error: '잘못된 기록입니다.' });
    }

    const acceptedSeconds = calculateAcceptedSeconds({ from, to, playbackRate, visible, playing });
    if (acceptedSeconds <= 0) return res.json({ accepted: false });

    const sessionResult = await query(`
      SELECT s.id, s.viewer_id, s.video_id, s.last_activity_at, v.owner_id
      FROM watch_sessions s
      JOIN videos v ON v.id = s.video_id
      WHERE s.id = $1 AND s.viewer_id = $2 AND s.video_id = $3
    `, [sessionId, req.session.user.id, videoId]);

    if (!sessionResult.rowCount) return res.status(403).json({ error: '유효하지 않은 시청 세션입니다.' });
    if (Number(sessionResult.rows[0].owner_id) === req.session.user.id) {
      return res.status(403).json({ error: '본인 작품은 평가할 수 없습니다.' });
    }

    // 같은 구간을 다시 보거나 영상을 처음부터 재시청해도 인정 시간을 다시 누적합니다.

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO watch_totals(viewer_id, video_id, cumulative_seconds, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (viewer_id, video_id)
        DO UPDATE SET
          cumulative_seconds = watch_totals.cumulative_seconds + EXCLUDED.cumulative_seconds,
          updated_at = NOW()
      `, [req.session.user.id, videoId, acceptedSeconds]);

      await client.query(`
        UPDATE watch_sessions
        SET last_activity_at = NOW(),
            last_position = $1,
            accumulated_seconds = accumulated_seconds + $2
        WHERE id = $3
      `, [to, acceptedSeconds, sessionId]);

      if (duration > 0 && duration < 86400) {
        await client.query(`
          UPDATE videos
          SET duration_seconds = $1, updated_at = NOW()
          WHERE id = $2
            AND (duration_seconds = 0 OR duration_seconds < $1 - 1 OR duration_seconds > $1 + 1)
        `, [Math.round(duration), videoId]);
      }
    });

    const totalResult = await query(`
      SELECT cumulative_seconds
      FROM watch_totals
      WHERE viewer_id = $1 AND video_id = $2
    `, [req.session.user.id, videoId]);

    res.json({
      accepted: true,
      acceptedSeconds,
      watchedSeconds: Math.max(0, Number(totalResult.rows[0]?.cumulative_seconds) || 0)
    });
  } catch (error) { next(error); }
});

app.post('/api/watch/event', requireEvaluator, async (req, res, next) => {
  try {
    const sessionId = Number(req.body.sessionId);
    const videoId = Number(req.body.videoId);
    const position = Math.max(0, Number(req.body.position) || 0);
    const allowed = new Set(['play', 'pause', 'ended', 'seek', 'tab_hidden', 'tab_visible', 'player_error', 'leave']);
    const eventType = String(req.body.eventType || '');
    if (!allowed.has(eventType)) return res.status(400).json({ error: '잘못된 이벤트입니다.' });
    const owner = await query('SELECT 1 FROM watch_sessions WHERE id = $1 AND viewer_id = $2 AND video_id = $3', [sessionId, req.session.user.id, videoId]);
    if (!owner.rowCount) return res.status(403).json({ error: '유효하지 않은 세션입니다.' });
    await query(`INSERT INTO watch_events(session_id, viewer_id, video_id, event_type, position) VALUES ($1,$2,$3,$4,$5)`, [sessionId, req.session.user.id, videoId, eventType, position]);
    if (eventType === 'ended' || eventType === 'leave') await query('UPDATE watch_sessions SET ended_at = NOW(), last_activity_at = NOW(), last_position = $1 WHERE id = $2', [position, sessionId]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const settings = await getSettings();
    const ranking = await getRanking(settings);
    const users = (await query(`SELECT id, name, role, active, created_at FROM users ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END, id`)).rows;
    const videos = (await query(`
      SELECT v.*, u.name AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id ORDER BY v.id
    `)).rows;
    const counts = (await query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE active = TRUE AND role = 'student')::int AS student_count,
        (SELECT COUNT(*) FROM videos WHERE active = TRUE)::int AS video_count,
        (SELECT COUNT(*) FROM watch_sessions)::int AS session_count,
        COALESCE((SELECT SUM(cumulative_seconds) FROM watch_totals), 0) AS cumulative_watch_seconds
    `)).rows[0];
    res.render('admin', { ranking, users, videos, counts, settings });
  } catch (error) { next(error); }
});

app.post('/admin/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const eventTitle = String(req.body.eventTitle || '').trim().slice(0, 100);
    if (!eventTitle) throw new Error('행사명을 입력하세요.');
    const evaluationOpen = req.body.evaluationOpen === '1' ? '1' : '0';
    const submissionOpen = evaluationOpen === '1' ? '0' : (req.body.submissionOpen === '1' ? '1' : '0');
    const minValid = Math.min(120, Math.max(1, Number(req.body.minValidSeconds || 10)));
    const anonymousMode = req.body.anonymousMode === '1' ? '1' : '0';
    await withTransaction(async (client) => {
      await setSetting('event_title', eventTitle, client);
      await setSetting('evaluation_open', evaluationOpen, client);
      await setSetting('submission_open', submissionOpen, client);
      await setSetting('min_valid_seconds', String(minValid), client);
      await setSetting('ranking_mode', 'composite', client);
      await setSetting('anonymous_mode', anonymousMode, client);
    });
    flash(req, 'success', '운영 설정을 저장했습니다.');
    res.redirect('/admin');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/admin#settings');
  }
});

app.post('/admin/users/bulk', requireRole('admin'), async (req, res, next) => {
  try {
    const videoCount = Number((await query('SELECT COUNT(*)::int AS count FROM videos')).rows[0].count);
    const watchCount = Number((await query('SELECT COUNT(*)::int AS count FROM watch_sessions')).rows[0].count);
    if (videoCount || watchCount) throw new Error('작품 또는 시청기록이 존재해 학생 명단을 일괄 교체할 수 없습니다. 개별 수정하거나 기록을 초기화하세요.');
    const students = parseStudentLines(req.body.students);
    if (students.length < 1 || students.length > 100) throw new Error('학생은 1명 이상 100명 이하로 등록하세요.');
    if (students.some((student) => !validatePin(student.pin))) throw new Error('모든 PIN은 숫자 4~12자리여야 합니다.');
    if (new Set(students.map((student) => student.pin)).size !== students.length) throw new Error('학생 PIN이 중복되었습니다.');
    const occupied = (await query(`SELECT pin_lookup FROM users WHERE role <> 'student'`)).rows.map((row) => row.pin_lookup);
    if (students.some((student) => occupied.includes(pinLookup(student.pin)))) throw new Error('관리자 또는 강사와 같은 PIN이 있습니다.');
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM users WHERE role = 'student'`);
      for (const student of students) {
        await client.query(`INSERT INTO users(name, pin_hash, pin_lookup, role) VALUES ($1,$2,$3,'student')`, [student.name.slice(0, 50), await bcrypt.hash(student.pin, 10), pinLookup(student.pin)]);
      }
    });
    flash(req, 'success', `${students.length}명의 학생 명단을 등록했습니다.`);
    res.redirect('/admin#accounts');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/admin#accounts');
  }
});

app.post('/admin/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim().slice(0, 50);
    const newPin = String(req.body.newPin || '').trim();
    let active = req.body.active === '1';
    if (req.session.user.id === id && req.session.user.role === 'admin') active = true;
    if (!name) throw new Error('이름을 입력하세요.');
    if (newPin && !validatePin(newPin)) throw new Error('새 PIN은 숫자 4~12자리여야 합니다.');
    if (newPin) {
      await query(`UPDATE users SET name=$1, active=$2, pin_hash=$3, pin_lookup=$4, updated_at=NOW() WHERE id=$5`, [name, active, await bcrypt.hash(newPin, 10), pinLookup(newPin), id]);
    } else {
      await query(`UPDATE users SET name=$1, active=$2, updated_at=NOW() WHERE id=$3`, [name, active, id]);
    }
    if (req.session.user.id === id) req.session.user.name = name;
    flash(req, 'success', '계정 정보를 수정했습니다.');
    res.redirect('/admin#accounts');
  } catch (error) {
    if (error.code === '23505') error.message = '이미 사용 중인 PIN입니다.';
    flash(req, 'error', error.message);
    res.redirect('/admin#accounts');
  }
});

app.post('/admin/videos/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM videos WHERE id = $1', [req.params.id]);
    flash(req, 'success', '작품과 해당 시청기록을 삭제했습니다.');
    res.redirect('/admin#submissions');
  } catch (error) { next(error); }
});

app.post('/admin/watch/reset', requireRole('admin'), async (req, res, next) => {
  try {
    if (String(req.body.confirm || '') !== 'RESET') throw new Error('확인란에 RESET을 입력해야 합니다.');
    await withTransaction(async (client) => {
      await client.query('TRUNCATE watch_events, watched_seconds, watch_totals, watch_sessions, display_orders RESTART IDENTITY');
    });
    flash(req, 'success', '모든 시청기록과 무작위 노출 순서를 초기화했습니다. 작품과 계정은 유지됩니다.');
    res.redirect('/admin');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/admin');
  }
});

app.get('/admin/video/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await query(`SELECT v.*, u.name AS owner_name FROM videos v JOIN users u ON u.id=v.owner_id WHERE v.id=$1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).render('error', { message: '작품을 찾을 수 없습니다.' });
    const rows = await getVideoViewerRows(req.params.id);
    res.render('video-detail', { video: result.rows[0], rows });
  } catch (error) { next(error); }
});

app.get('/admin/viewer/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await query(`SELECT id, name, role FROM users WHERE id=$1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).render('error', { message: '계정을 찾을 수 없습니다.' });
    const rows = await getViewerVideoRows(req.params.id);
    res.render('viewer-detail', { viewer: result.rows[0], rows });
  } catch (error) { next(error); }
});

app.get('/admin/export.csv', requireRole('admin'), async (req, res, next) => {
  try {
    const settings = await getSettings();
    const ranking = await getRanking(settings);
    const matrix = await getViewerMatrix();
    const lines = [];
    lines.push([
      '순위','작품','제작자','영상길이','평가가능인원','클릭한평가자','누적시청시간(초)',
      '평균시청시간(초)','평균시청지속비율(%)','클릭률(%)',
      '평균시청시간점수','시청지속비율점수','클릭률점수','최종종합점수'
    ].map(escapeCsv).join(','));
    ranking.forEach((row) => lines.push([
      row.rank, row.title, row.owner_name, row.duration_seconds, row.eligible_count, row.clicked_viewers,
      row.total_watch_seconds.toFixed(2), row.average_watch_seconds.toFixed(2),
      row.average_retention_rate.toFixed(2), row.click_rate.toFixed(2),
      row.watch_time_score.toFixed(2), row.retention_score.toFixed(2),
      row.click_score.toFixed(2), row.final_score.toFixed(2)
    ].map(escapeCsv).join(',')));
    lines.push('');
    lines.push(['시청자', '역할', ...matrix.videos.map((video) => video.title)].map(escapeCsv).join(','));
    matrix.users.forEach((user) => lines.push([
      user.name, user.role,
      ...matrix.videos.map((video) => Number(video.owner_id) === Number(user.id) ? '본인' : matrix.getSeconds(user.id, video.id))
    ].map(escapeCsv).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="video-evaluation-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(`\uFEFF${lines.join('\r\n')}`);
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).render('error', { message: '페이지를 찾을 수 없습니다.' }));

app.use((error, req, res, next) => {
  console.error(error);
  const status = Number(error.status || 500);
  const message = status >= 500 && isProduction ? '서버 오류가 발생했습니다.' : error.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  if (req.session) {
    flash(req, 'error', message);
    let refererPath = '';
    try { refererPath = req.headers.referer ? new URL(req.headers.referer).pathname : ''; } catch (_) {}
    return res.redirect(safeReturnTo(refererPath, '/'));
  }
  res.status(status).render('error', { message });
});

async function start() {
  await migrate();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Video Evaluation Web v2.1.0: http://localhost:${PORT}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, start };
