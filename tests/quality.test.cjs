const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualityFromLabel, selectQualityStream, selectMediaUrl, downloadQualities, defaultDownloadQuality } = require('../Bili-Peek.user.js');

test('download choices use actual safe tracks, default to 1080P or highest available, and ignore advertised locked qualities', () => {
  const stream = id => ({ id, baseUrl: 'https://test.bilivideo.com/' + id });
  const data = { accept_quality: [127, 120, 80, 64], dash: { video: [stream(120), stream(80), stream(80), stream(64), { id: 127, baseUrl: 'http://unsafe.example/v' }], audio: [stream(30280)] } };
  const list = downloadQualities(data);
  assert.deepEqual(list.map(item => item.id), [120, 80, 64]);
  assert.equal(defaultDownloadQuality(list), 80);
  assert.equal(defaultDownloadQuality(downloadQualities({ ...data, dash: { ...data.dash, video: [stream(64), stream(32)] } })), 64);
  assert.equal(defaultDownloadQuality(downloadQualities({ ...data, dash: { ...data.dash, video: [stream(120)] } })), 120);
  assert.deepEqual(downloadQualities({ dash: { video: [stream(80)], audio: [] } }), []);
});

test('media address fallback keeps signed URLs intact and rejects unsafe addresses', () => {
  const good = 'https://video.bilivideo.com:443/file?sign=a%2Bb&deadline=123';
  assert.equal(selectMediaUrl({ base_url: good, backup_url: ['https://other.bilivideo.cn/backup'] }), good);
  assert.equal(selectMediaUrl({ baseUrl: 'invalid', backupUrl: [null, good] }), good);
  for (const candidate of ['http://video.bilivideo.com/file', 'https://127.0.0.1/file', 'https://bilivideo.com.attacker.example/file', 'https://user:secret@video.bilivideo.com/file', 'https://video.bilivideo.com:448/file', 'file:///video.mp4']) {
    assert.equal(selectMediaUrl({ baseUrl: candidate }), null);
    assert.equal(selectMediaUrl({ baseUrl: candidate, backup_url: [good] }), good);
  }
});

test('prepareExport selects safe backup URLs from the same tracks before helper validation', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { validateTask } = require('../helper/export.cjs');
  const { selectMediaUrl } = require('../Bili-Peek.user.js');
  const source = await fs.readFile(path.resolve(__dirname, '../Bili-Peek.user.js'), 'utf8');
  const videoUrl = 'https://video.bilivideo.com/video.m4s?token=signed';
  const audioUrl = 'https://audio.bilivideo.cn/audio.m4s?token=signed';
  const state = vm.createContext({
    URL, AbortController, currentQuality: () => 80, selectQualityStream, selectMediaUrl, downloadQualities, defaultDownloadQuality,
    helperRequest: async () => ({ query: 'signed' }),
    request: async url => {
      if (url.includes('/view?')) return { code: 0, data: { title: '测试', pages: [{ page: 1, cid: 123, duration: 30 }] } };
      if (url.includes('/v2?')) return { code: 0, data: {} };
      if (url.endsWith('/nav')) return { data: { wbi_img: { img_url: 'https://i.example/a.png', sub_url: 'https://i.example/b.png' } } };
      if (url.includes('/playurl?')) return { code: 0, data: { dash: {
        video: [{ id: 80, codecs: 'avc1', baseUrl: 'https://peer.bilivideo.com:448/video.m4s', backupUrl: [videoUrl], SegmentBase: { Initialization: '0-799', indexRange: '800-999' } }],
        audio: [{ bandwidth: 100, codecs: 'mp4a', base_url: 'http://audio.bilivideo.cn/audio.m4s', backup_url: [audioUrl], segment_base: { initialization: '0-699', index_range: '700-899' } }]
      } } };
      throw new Error('unexpected request');
    }
  });
  const start = source.indexOf('  async function loadExportMedia(');
  vm.runInContext(source.slice(start, source.indexOf("  if (typeof GM_registerMenuCommand", start)), state);
  const task = await state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token');
  task.tags = ['测试'];
  assert.doesNotThrow(() => validateTask(task));
  assert.equal(task.videoUrl, videoUrl);
  assert.equal(task.audioUrl, audioUrl);
  assert.deepEqual(Array.from(task.videoUrls), [videoUrl]);
  assert.deepEqual(Array.from(task.audioUrls), [audioUrl]);
  assert.equal(task.videoTrack.init, '0-799'); assert.equal(task.videoTrack.index, '800-999');
  assert.equal(task.audioTrack.init, '0-699'); assert.equal(task.audioTrack.index, '700-899');
  assert.equal(task.downloadQuality, 80);
  await assert.rejects(state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token', 120), /所选下载画质/);
  assert.notEqual(require('../helper/export.cjs').keyFor(task), require('../helper/export.cjs').keyFor({ ...task, downloadQuality: 64 }));
});

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
