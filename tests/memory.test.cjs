const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../Bili-Peek.user.js'), 'utf8');

test('phrase deduplication index stays bounded by actual phrase candidates', () => {
  let index;
  class NestedSet extends Set { constructor() { super(); index = this; } }
  const state = { module: { exports: {} }, NestedSet };
  vm.runInNewContext(source.replace('const nested = new Set();', 'const nested = new NestedSet();'), state);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ text: `服务器内存型号${Math.floor(i / 2)}价格上涨`, mode: 1, pool: 0 }));
  const result = state.module.exports.wordStats(rows, true);
  // Six tokens produce at most twelve 2–4-token candidates per unique message.
  assert.ok(index.size <= 500 * 12, `substring index has ${index.size} entries`);
  assert.ok(result.some(term => term.text === '价格上涨' && term.count === 1000));
});

// Exercise the actual loader with network and chart rendering replaced at their boundaries.
function loader() {
  const sandbox = {
    AbortController, Date, Map, Set,
    document: { scripts: [] }, location: { href: 'BVtest:p1' },
    routeKey: value => value, parsePageState: () => null,
    ui: { 'clip-start': {}, 'clip-end': {} },
    loading() { sandbox.records = []; sandbox.chartData = null; },
    status() {}, renderCharts() {},
    dataRoute: null, dataRequest: null, currentRoute: 'BVtest:p1',
    cache: new Map(), records: [], videoDuration: 0,
    request: async url => url.includes('seg.so') ? {} : {
      code: 0, data: { aid: 1, pages: [1, 2, 3].map(page => ({ page, cid: page, duration: 10 })) }
    },
    decodeDanmaku: () => ({ records: [
      { id: '1', text: '内存内存', time: 1, mode: 1, pool: 0 },
      { id: '1', text: '内存内存', time: 1, mode: 1, pool: 0 },
      { id: '2', text: '内存内存', time: 2, mode: 1, pool: 0 }
    ] })
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('  async function loadData('), source.indexOf('  function onMediaState(')), sandbox);
  return sandbox;
}

test('switching parts retains only current danmaku and drops IDs after deduplication', async () => {
  const state = loader();
  for (const part of [1, 2, 3]) {
    state.location.href = state.currentRoute = `BVtest:p${part}`;
    await state.loadData(state.currentRoute);
    assert.equal(state.cache.size, 1);
    assert.equal(state.cache.has(state.currentRoute), true);
    assert.equal(state.records.length, 2);
    assert.equal(state.records[0].text, '内存内存');
    assert.equal('id' in state.records[0], false);
  }
});

test('failed forced reload releases previous data and leaves a retryable error', async () => {
  const state = loader();
  await state.loadData(state.currentRoute);
  state.request = async () => { throw new Error('network failure'); };
  let error;
  state.loading = message => { state.records = []; error = message; };
  await state.loadData(state.currentRoute, true);
  assert.equal(state.cache.size, 0);
  assert.equal(state.records.length, 0);
  assert.equal(error, 'network failure');
});

test('cancelled download cannot repopulate cache after leaving the page', async () => {
  const state = loader();
  const request = state.request;
  let finish, started;
  const downloading = new Promise(resolve => { started = resolve; });
  state.request = url => url.includes('seg.so') ? new Promise(resolve => { finish = resolve; started(); }) : request(url);
  const pending = state.loadData(state.currentRoute);
  await downloading;
  state.dataRequest.abort(); state.cache.clear();
  finish({}); await pending;
  assert.equal(state.cache.size, 0);
  assert.equal(state.records.length, 0);
  assert.equal(state.dataRequest, null);
});

test('pagehide releases data, media listeners and scheduling; pageshow can schedule again', () => {
  const state = loader();
  const observer = () => ({ disconnect() {} });
  Object.assign(state, {
    observer: observer(), themeObserver: observer(), playerModeObserver: observer(), sizeObserver: observer(),
    observedPlayer: {}, cancelSeek() {}, clearTimeout() {}, scheduled: 123,
    helperTimer: 456, pageSuspended: false, syncHelper() {},
    media: {}, bindMedia(next) { state.media = next; },
    records: [{ text: 'previous' }], chartData: { bins: [] },
    ui: { cloud: { replaceChildren() {} }, density: { replaceChildren() {} } },
    window: { addEventListener(name, callback) { state[name] = callback; } }
  });
  state.cache.set('old', { records: state.records });
  state.dataRequest = new AbortController();
  const controller = state.dataRequest;
  const start = source.indexOf("  window.addEventListener('pagehide', () => {");
  vm.runInContext(source.slice(start, source.indexOf('  function diagnosticReport()', start)), state);
  state.pagehide();
  assert.equal(controller.signal.aborted, true);
  assert.equal(state.cache.size, 0);
  assert.equal(state.records.length, 0);
  assert.equal(state.chartData, null);
  assert.equal(state.media, null);
  assert.equal(state.scheduled, null);
  assert.equal(state.pageSuspended, true);
  let observed = false, scheduled = false;
  state.observePage = () => { observed = true; };
  state.schedule = () => { assert.equal(state.scheduled, null); scheduled = true; };
  state.pageshow({ persisted: true });
  assert.equal(observed && scheduled, true);
  assert.equal(state.pageSuspended, false);
});
