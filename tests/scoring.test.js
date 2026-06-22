const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCompositeScores } = require('../lib/scoring');

test('세 지표를 각각 최고값 대비 100점으로 환산해 동일 가중치로 합산한다', () => {
  const rows = applyCompositeScores([
    { id: 1, average_watch_seconds: 600, average_retention_rate: 100, click_rate: 50 },
    { id: 2, average_watch_seconds: 300, average_retention_rate: 75, click_rate: 100 }
  ]);

  const first = rows.find((row) => row.id === 1);
  const second = rows.find((row) => row.id === 2);
  assert.equal(first.watch_time_score, 100);
  assert.equal(first.retention_score, 100);
  assert.equal(first.click_score, 50);
  assert.ok(Math.abs(first.final_score - 83.3333333333) < 0.001);
  assert.equal(second.watch_time_score, 50);
  assert.equal(second.retention_score, 75);
  assert.equal(second.click_score, 100);
  assert.equal(second.final_score, 75);
  assert.equal(rows[0].id, 1);
});

test('반복 시청으로 지속비율이 100%를 넘어도 점수 계산이 가능하다', () => {
  const rows = applyCompositeScores([
    { id: 1, average_watch_seconds: 900, average_retention_rate: 150, click_rate: 80 },
    { id: 2, average_watch_seconds: 600, average_retention_rate: 100, click_rate: 80 }
  ]);
  assert.equal(rows[0].retention_score, 100);
  assert.ok(rows[1].retention_score > 66 && rows[1].retention_score < 67);
});
