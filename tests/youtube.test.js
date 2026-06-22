const test = require('node:test');
const assert = require('node:assert/strict');
const { extractYouTubeId } = require('../lib/youtube');

test('YouTube 링크 형식을 영상 ID로 변환한다', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(extractYouTubeId(`https://youtu.be/${id}`), id);
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${id}&t=10`), id);
  assert.equal(extractYouTubeId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(extractYouTubeId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(extractYouTubeId('not-a-url'), null);
});
