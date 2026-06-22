const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateAcceptedSeconds } = require('../lib/watch');

test('같은 구간을 실제로 두 번 재생하면 두 번 모두 누적할 수 있다', () => {
  const heartbeat = { from: 0.2, to: 4.1, playbackRate: 1, visible: true, playing: true };
  const first = calculateAcceptedSeconds(heartbeat);
  const second = calculateAcceptedSeconds(heartbeat);
  assert.ok(Math.abs(first - 3.9) < 0.001);
  assert.ok(Math.abs(first + second - 7.8) < 0.001);
});

test('정지·숨김 탭·건너뛰기·배속 재생은 인정하지 않는다', () => {
  assert.equal(calculateAcceptedSeconds({ from: 0, to: 4, playbackRate: 1, visible: false, playing: true }), 0);
  assert.equal(calculateAcceptedSeconds({ from: 0, to: 4, playbackRate: 1, visible: true, playing: false }), 0);
  assert.equal(calculateAcceptedSeconds({ from: 0, to: 20, playbackRate: 1, visible: true, playing: true }), 0);
  assert.equal(calculateAcceptedSeconds({ from: 0, to: 4, playbackRate: 2, visible: true, playing: true }), 0);
});
