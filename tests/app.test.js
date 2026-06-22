process.env.USE_PGMEM = '1';
process.env.SESSION_STORE = 'memory';
process.env.SESSION_SECRET = 'test-secret-at-least-long-enough';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../server');
const { migrate, query, pool } = require('../db');

let originalFetch;

test.before(async () => {
  originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ title: '테스트 영상', author_name: 'Tester' })
  });
  await migrate();
});

test.after(async () => {
  global.fetch = originalFetch;
  await pool.end();
});

test('초기 설정부터 제출·평가·누적 시청시간 및 종합점수까지 동작한다', async () => {
  const setup = await request(app)
    .post('/setup')
    .type('form')
    .send({
      eventTitle: '테스트 평가', adminName: '관리자', adminPin: '9999',
      teacherName: '강사', teacherPin: '9000',
      students: '학생A,1001\n학생B,1002'
    });
  assert.equal(setup.status, 302);
  assert.equal(setup.headers.location, '/login?setup=1');

  const student = request.agent(app);
  let response = await student.post('/login').type('form').send({ pin: '1001' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/videos');

  response = await student.post('/submit').type('form').send({
    title: 'A의 작품', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ'
  });
  assert.equal(response.status, 302);

  const admin = request.agent(app);
  await admin.post('/login').type('form').send({ pin: '9999' });
  response = await admin.post('/admin/settings').type('form').send({
    eventTitle: '테스트 평가', submissionOpen: '0', evaluationOpen: '1',
    minValidSeconds: '1', rankingMode: 'composite', anonymousMode: '1'
  });
  assert.equal(response.status, 302);

  const teacher = request.agent(app);
  await teacher.post('/login').type('form').send({ pin: '9000' });
  response = await teacher.get('/videos');
  assert.equal(response.status, 200);
  assert.match(response.text, /A의 작품/);

  const video = (await query('SELECT id FROM videos LIMIT 1')).rows[0];
  response = await teacher.post('/api/watch/start').send({ videoId: Number(video.id) });
  assert.equal(response.status, 200);
  const sessionId = response.body.sessionId;
  assert.ok(sessionId);

  response = await teacher.post('/api/watch/heartbeat').send({
    sessionId, videoId: Number(video.id), from: 0.2, to: 4.1,
    duration: 600, playbackRate: 1, visible: true, playing: true
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.accepted, true);
  assert.ok(Math.abs(response.body.watchedSeconds - 3.9) < 0.01);

  response = await teacher.post('/api/watch/heartbeat').send({
    sessionId, videoId: Number(video.id), from: 0.2, to: 4.1,
    duration: 600, playbackRate: 1, visible: true, playing: true
  });
  assert.ok(Math.abs(response.body.watchedSeconds - 7.8) < 0.01, '반복 구간도 누적 집계한다');

  response = await admin.get('/admin');
  assert.equal(response.status, 200);
  assert.match(response.text, /A의 작품/);
  assert.match(response.text, /0:07/); // 클릭한 강사 1명의 평균 누적 시청시간

  response = await student.get('/videos');
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /A의 작품/, '본인 작품은 목록에서 제외한다');

  response = await teacher.get(`/watch/${video.id}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /youtubePlayer/);

  response = await teacher.post('/api/watch/heartbeat').send({
    sessionId, videoId: Number(video.id), from: 4.1, to: 8.0,
    duration: 600, playbackRate: 1, visible: false, playing: true
  });
  assert.equal(response.body.accepted, false, '숨겨진 탭의 시간은 거부한다');

  response = await admin.get(`/admin/video/${video.id}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /강사/);

  response = await admin.get('/admin/export.csv');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.ok(response.text.startsWith('﻿순위'));
});
