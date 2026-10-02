const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualityFromLabel, selectQualityStream } = require('../Bili-Peek.user.js');

test('recognize selected quality including frame rate and high bitrate variants', () => {
  for (const [label, quality] of [['360P 流畅', 16], ['480P 清晰', 32], ['720P 高清', 64], ['720P 60帧', 74], ['1080P 高清', 80], ['1080P 高码率', 112], ['1080P 60帧', 116], ['4K 超清', 120], ['HDR 真彩', 125]]) {
    assert.equal(qualityFromLabel(label), quality);
  }
  assert.equal(qualityFromLabel('自动'), null);
  assert.equal(qualityFromLabel(''), null);
});

test('use exactly selected quality and never substitute lower or higher quality', () => {
  const streams = [{ id: 64, codecs: 'avc1' }, { id: 80, codecs: 'hev1' }, { id: 120, codecs: 'avc1' }, { id: 80, codecs: 'avc1' }];
  assert.equal(selectQualityStream(streams, 80), streams[3]);
  assert.equal(selectQualityStream(streams, 120), streams[2]);
  assert.equal(selectQualityStream(streams, 116), undefined);
  assert.equal(selectQualityStream([streams[1]], 80), streams[1]);
});
