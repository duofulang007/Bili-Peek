const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectQualityStream, selectMediaUrl, downloadQualities, defaultDownloadQuality, folderMatches } = require('../Bili-Peek.user.js');

test('latest note link stays visible through status resets and selects the newest successful segment per video', () => {
  const source = require('node:fs').readFileSync(require.resolve('../Bili-Peek.user.js'), 'utf8');
  const vm = require('node:vm'), stored = {};
  const state = { ui: { 'open-note': {}, status: { dataset: {} } }, latestNotes: new Map(), currentRoute: 'BVtest:p1', savedValue: (key, fallback) => stored[key] || fallback, GM_setValue: (key, value) => { stored[key] = value; }, diagnostic: {}, console };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function renderNoteLink()'), source.indexOf('  function updateClipUI(')), state);
  vm.runInContext(source.slice(source.indexOf('  function status('), source.indexOf('  function ready()')), state);
  state.rememberNote('BVtest:p1', { obsidianUri: 'obsidian://open?path=first.md', completedAt: 10 });
  state.status(''); assert.equal(state.ui['open-note'].hidden, false);
  state.currentRoute = 'BVtest:p2';
  state.rememberNote('BVtest:p1', { obsidianUri: 'obsidian://open?path=newest.md', completedAt: 20 });
  state.rememberNote('BVtest:p2', { obsidianUri: 'obsidian://open?path=late-old-result.md', completedAt: 15 });
  assert.equal(state.ui['open-note'].href, 'obsidian://open?path=newest.md');
  stored['latest-export-notes'].BVsecondTab = { uri: 'obsidian://open?path=other.md', at: 30 };
  state.rememberNote('BVtest:p1', { obsidianUri: 'obsidian://open?path=latest.md', completedAt: 40 });
  assert.equal(stored['latest-export-notes'].BVsecondTab.uri, 'obsidian://open?path=other.md');
  state.latestNotes = new Map(Object.entries(stored['latest-export-notes']));
  state.renderNoteLink(); assert.equal(state.ui['open-note'].hidden, false, 'persisted link restores after reload');
  state.currentRoute = 'BVother:p1'; state.renderNoteLink(); assert.equal(state.ui['open-note'].hidden, true);
});

test('save opens editable metadata before helper/media resolve, preserves edits on retry and ignores completion after cancel', async () => {
  const source = require('node:fs').readFileSync(require.resolve('../Bili-Peek.user.js'), 'utf8');
  const vm = require('node:vm');
  let nodes = {};
  class Node {
    constructor() { this.value = ''; this.children = []; this.listeners = {}; this.parentElement = this; this.isConnected = false; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(node) { this.children.push(node); }
    after() {}
    setAttribute() {}
    removeAttribute() {}
    setCustomValidity() {}
    focus() {}
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.isConnected = false; }
    replaceChildren() { this.children = []; }
    set id(value) { nodes['#' + value] = this; }
    querySelector(selector) { return nodes[selector] ||= new Node(); }
    click() { return this.listeners.click?.({ preventDefault() {} }); }
  }
  let dialog, releaseHealth, releaseMedia, attempts = 0;
  const state = {
    document: { title: '测试视频', createElement(type) { const node = new Node(); if (type === 'dialog') { dialog = node; nodes = {}; } return node; } },
    host: { shadowRoot: { append(node) { node.isConnected = true; } } },
    ui: Object.fromEntries(['jump-start', 'clip-start', 'jump-end', 'clip-end', 'range-start', 'range-end', 'range-window', 'save-clip'].map(id => [id, new Node()])),
    currentRoute: 'BVtest:p1', location: { href: 'BVtest:p1' }, routeKey: value => value,
    clipRange: { start: 0, end: 30 }, exportingRoutes: new Set(), exportDrafts: new Map(),
    commitClipInputs: () => true, updateClipUI() {}, savedValue: () => 'token', status() {},
    helperRequest: endpoint => endpoint === '/folders' ? Promise.resolve({ folders: ['.', '学习'], defaultDirectory: '学习' }) : new Promise(resolve => { releaseHealth = resolve; }),
    loadExportMedia: () => { attempts++; return new Promise((resolve, reject) => { releaseMedia = { resolve, reject }; }); },
    formatTime: String, defaultDownloadQuality, folderMatches, GM_getValue: () => [], GM_setValue() {},
    transferStates: new Map()
  };
  vm.createContext(state);
  vm.runInContext(source.slice(source.indexOf('  function bindClipControls('), source.indexOf('  function helperRequest(')), state);
  state.bindClipControls();
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const saving = state.ui['save-clip'].click();
  assert.ok(dialog?.open, 'dialog must open in the click handler before the health request resolves');
  assert.equal(dialog.querySelector('#export-confirm').disabled, true);
  const tags = dialog.querySelector('#export-tags'), summary = dialog.querySelector('#export-summary');
  tags.value = '学习'; summary.value = '先写的摘要';
  dialog.listeners.input();
  releaseHealth({ ready: true, segmentAvailable: true }); await flush();
  releaseMedia.reject(new Error('画质请求失败')); await flush();
  assert.ok(dialog.open);
  assert.equal(dialog.querySelector('#export-confirm').disabled, true);
  assert.equal(dialog.querySelector('#export-quality-retry').hidden, false);
  assert.match(dialog.querySelector('#export-quality-status').textContent, /画质请求失败/);
  dialog.querySelector('#export-quality-retry').click();
  releaseHealth({ ready: true, segmentAvailable: true }); await flush();
  releaseMedia.resolve({ qualities: [{ id: 80, label: '1080P' }], info: { data: { title: '接口确认的当前视频标题' } } }); await flush();
  assert.equal(attempts, 2);
  assert.equal(dialog.querySelector('#export-confirm').disabled, false);
  assert.equal(tags.value, '学习'); assert.equal(summary.value, '先写的摘要');
  assert.equal(dialog.querySelector('#export-quality').value, '80');
  assert.equal(dialog.querySelector('#export-name').value, '接口确认的当前视频标题');
  dialog.querySelector('#export-cancel').click(); await saving;
  const cancelled = state.ui['save-clip'].click();
  const closed = dialog;
  dialog.querySelector('#export-cancel').click(); await cancelled;
  releaseHealth({ ready: true }); await flush();
  releaseMedia.resolve({ qualities: [{ id: 64, label: '720P' }], info: { data: { title: '迟到的旧标题' } } }); await flush();
  assert.equal(closed.isConnected, false); assert.equal(closed.open, false);
  assert.equal(state.exportingRoutes.size, 0);
  state.currentRoute = state.location.href = 'BVsecond:p1';
  const second = state.ui['save-clip'].click();
  releaseHealth({ ready: true, segmentAvailable: true }); await flush();
  releaseMedia.resolve({ qualities: [{ id: 80, label: '1080P' }], info: { data: { title: '第二个视频的新标题' } } }); await flush();
  assert.equal(dialog.querySelector('#export-name').value, '第二个视频的新标题', 'stale document title must not name a new video');
  dialog.querySelector('#export-cancel').click(); await second;
  const manual = state.ui['save-clip'].click();
  dialog.querySelector('#export-name').value = '手动命名的新片段'; dialog.querySelector('#export-name').listeners.input(); dialog.listeners.input();
  releaseHealth({ ready: true, segmentAvailable: true }); await flush();
  releaseMedia.resolve({ qualities: [{ id: 80, label: '1080P' }], info: { data: { title: '接口标题不能覆盖自定义' } } }); await flush();
  assert.equal(dialog.querySelector('#export-name').value, '手动命名的新片段');
  dialog.querySelector('#export-cancel').click(); await manual;
});

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
  const request = state.request;
  state.request = async url => { if (url.includes('/v2?')) throw new Error('网络中断'); return request(url); };
  await assert.rejects(state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token'), /字幕信息读取失败.*网络中断/);
  state.request = async url => { if (url.includes('/v2?')) return { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://subtitle.bilibili.com/test.json' }] } } }; if (url.includes('subtitle.bilibili.com')) throw new Error('字幕服务器失败'); return request(url); };
  await assert.rejects(state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token'), /字幕下载失败.*字幕服务器失败/);
  state.request = async url => { const response = await request(url); if (url.includes('/view?')) response.data.bvid = 'BVotherVideo'; return response; };
  await assert.rejects(state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token'), /视频信息与当前页面不一致/);
  state.request = async url => url.includes('/v2?') ? { code: 0, data: { cid: 999 } } : request(url);
  await assert.rejects(state.prepareExport('BV1xx411c7mD:p1', { start: 1, end: 3 }, 'test-token'), /字幕信息与当前分 P 不一致/);
});

test('use exactly selected quality and never substitute lower or higher quality', () => {
  const streams = [{ id: 64, codecs: 'avc1' }, { id: 80, codecs: 'hev1' }, { id: 120, codecs: 'avc1' }, { id: 80, codecs: 'avc1' }];
  assert.equal(selectQualityStream(streams, 80), streams[3]);
  assert.equal(selectQualityStream(streams, 120), streams[2]);
  assert.equal(selectQualityStream(streams, 116), undefined);
  assert.equal(selectQualityStream([streams[1]], 80), streams[1]);
});

test('keep the runtime version single-sourced so the panel never reports a stale build', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../Bili-Peek.user.js'), 'utf8');
  const meta = /^\/\/ @version\s+(\S+)/m.exec(source)?.[1];
  const runtime = /const SCRIPT_VERSION = '([^']+)'/.exec(source)?.[1];
  const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8')).version;
  // @version / SCRIPT_VERSION / package.json 必须一致，否则报错信息里的版本会撒谎。
  assert.equal(runtime, meta, 'SCRIPT_VERSION 与 @version 不一致');
  assert.equal(pkg, meta, 'package.json 与 @version 不一致');
  // 硬编码字面量赋值是本 bug 的来源，禁止回归。
  assert.doesNotMatch(source, /host\.dataset\.version = '\d/, 'dataset.version 必须走 SCRIPT_VERSION');
});
