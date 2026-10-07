const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsRecognition, parseSrt } = require('../helper/transcription.cjs');
test('Buzz only fills confirmed missing source subtitles, not empty selection or unknown metadata', () => {
  assert.equal(needsRecognition({ sourceHasSubtitles: false, subtitles: [] }), true);
  assert.equal(needsRecognition({ sourceHasSubtitles: true, subtitles: [] }), false);
  assert.equal(needsRecognition({ subtitles: [] }), false);
  assert.equal(needsRecognition({ sourceHasSubtitles: false, subtitles: [{ content: '原文' }] }), false);
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:03,200\n识别第一行\n识别第二行\n', 5);
  assert.deepEqual(cues, [{ from: 1, to: 3.2, content: '识别第一行\n识别第二行' }]);
  assert.deepEqual(parseSrt('', 5), []);
  assert.throws(() => parseSrt('1\n00:00:99,000 --> 00:02:00,000\n原文', 180));
  assert.throws(() => parseSrt('1\n00:00:01,000 --> 00:01:00,000\n原文', 5));
});
