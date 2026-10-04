const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { preparePairing } = require('../helper/pairing.cjs');

test('paired pages follow CPod even when the removed independent-mode preference was saved', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.resolve(__dirname, '../Bili-Peek.user.js'), 'utf8');
  const values = new Map([['controlpod-managed', false]]);
  const state = vm.createContext({ savedValue: (key, fallback) => values.has(key) ? values.get(key) : fallback });
  const start = source.indexOf('  const managed =');
  vm.runInContext(source.slice(start, source.indexOf('\n', start)) + '\nglobalThis.isManaged = managed;', state);
  assert.equal(state.isManaged(), false, 'unpaired charts remain usable');
  values.set('export-token', 'a'.repeat(64));
  assert.equal(state.isManaged(), true, 'paired charts always follow the helper');
});

test('helper polling schedules panel updates on start, stop and restart without refreshing', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.resolve(__dirname, '../Bili-Peek.user.js'), 'utf8');
  let online = false, poll, updates = 0, nextDelay;
  const state = vm.createContext({
    helperOnline: false, helperFailures: 0, helperTimer: null, helperSync: 0,
    helperManaged: true, pageSuspended: false,
    managed: () => true, savedValue: () => 'test-token', clearTimeout() {},
    helperRequest: async (endpoint, token, body, timeout) => { assert.ok(timeout <= 250); if (!online) throw new Error('offline'); return { ready: true }; },
    schedule: delay => { assert.equal(delay, 0); updates++; },
    setTimeout(callback, delay) { assert.ok(delay <= 250); nextDelay = delay; poll = callback; return 1; }
  });
  const start = source.indexOf('  async function syncHelper()');
  vm.runInContext(source.slice(start, source.indexOf('  async function connectFromCPod()', start)), state);
  await state.syncHelper();
  assert.equal(state.helperOnline, false);
  online = true; await poll();
  assert.equal(state.helperOnline, true); assert.equal(updates, 1);
  online = false; await poll();
  assert.equal(state.helperOnline, true, 'one transient failure keeps the panel');
  assert.equal(nextDelay, 50, 'confirm disconnection promptly instead of waiting another polling period');
  await poll();
  assert.equal(state.helperOnline, false); assert.equal(updates, 2);
  online = true; await poll();
  assert.equal(state.helperOnline, true); assert.equal(updates, 3);
  assert.equal(nextDelay, 250);
});

test('stopped helper removes charts within 800ms even when browser requests time out', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.resolve(__dirname, '../Bili-Peek.user.js'), 'utf8');
  let elapsed = 0, poll, delay, removedAt;
  const state = vm.createContext({
    helperOnline: true, helperFailures: 0, helperTimer: null, helperSync: 0,
    helperManaged: true, pageSuspended: false,
    managed: () => true, savedValue: () => 'test-token', helperPort: () => 18766,
    GM_xmlhttpRequest(options) { elapsed += options.timeout; options.ontimeout(); },
    clearTimeout() {}, setTimeout(callback, ms) { poll = callback; delay = ms; return 1; },
    schedule() { if (!state.helperOnline) removedAt = elapsed; }
  });
  const start = source.indexOf('  function helperRequest(');
  vm.runInContext(source.slice(start, source.indexOf('  async function connectFromCPod()', start)), state);
  // First measure the normal polling delay: stop can occur just after a successful probe.
  state.GM_xmlhttpRequest = options => options.onload({ status: 200, responseText: '{"ready":true}' });
  await state.syncHelper();
  state.GM_xmlhttpRequest = options => { elapsed += options.timeout; options.ontimeout(); };
  elapsed += delay; await poll();
  assert.equal(state.helperOnline, true, 'a single timeout must not remove charts');
  elapsed += delay; await poll();
  assert.equal(state.helperOnline, false);
  assert.ok(removedAt <= 800, `chart removal scheduled after ${removedAt}ms`);
});

test('userscript handoff clears URL, persists pairing and schedules without prompting', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.resolve(__dirname, '../Bili-Peek.user.js'), 'utf8');
  const values = new Map(); let cleaned = false, scheduled = false, notice = '';
  const ticket = 'a'.repeat(64);
  const state = vm.createContext({
    URLSearchParams,
    location: { hash: '#bili-peek-connect=' + ticket + '&port=19999', pathname: '/', search: '' },
    history: { state: null, replaceState(state, unused, url) { assert.equal(url, '/'); cleaned = true; } },
    helperRequest: async (endpoint, token, body, timeout, port, supplied) => {
      assert.equal(cleaned, true); assert.equal(endpoint, '/pair'); assert.equal(port, 19999); assert.equal(supplied, ticket);
      return { token: 'c'.repeat(64), port };
    },
    GM_setValue: (key, value) => values.set(key, value), helperOnline: false,
    schedule: () => { scheduled = true; }, connectionNotice: message => { notice = message; }
  });
  const start = source.indexOf('  async function connectFromCPod()');
  vm.runInContext(source.slice(start, source.indexOf('  function connectionNotice', start)), state);
  await state.connectFromCPod();
  assert.equal(values.get('export-token'), 'c'.repeat(64));
  assert.equal(values.get('export-port'), 19999);
  assert.ok(scheduled && state.helperOnline && notice.includes('已连接'));
});

test('real helper: automatic pairing, origin/auth checks, replay/expiry rejection and stable restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-peek-control-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { vault: directory, output: directory, ffmpeg: process.execPath, ffprobe: process.execPath, port, token: 'c'.repeat(64) };
  await fs.mkdir(path.join(directory, '.obsidian'));
  const configPath = path.join(directory, 'export-config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  let child, logs;
  async function start() {
    logs = '';
    child = spawn(process.execPath, [path.resolve(__dirname, '../helper/server.cjs')], { env: { ...process.env, BILI_PEEK_CONFIG: configPath }, windowsHide: true });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    for (let i = 0; i < 100; i++) {
      try { if ((await request('/health', { 'X-Bili-Peek-Token': config.token })).body.ready) return; } catch {}
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Helper failed to start: ' + logs);
  }
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  async function request(endpoint, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: endpoint === '/pair' || /\/(pause|resume|cancel)$/.test(endpoint) ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(1000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    await start();
    assert.equal((await request('/health')).status, 401);
    assert.equal(Number(await fs.readFile(path.join(directory, 'helper.pid'), 'utf8')), child.pid);
    const url = await preparePairing(config, directory);
    assert.ok(!url.includes(config.token));
    const ticket = new URLSearchParams(new URL(url).hash.slice(1)).get('bili-peek-connect');
    assert.equal((await request('/pair')).status, 401);
    assert.equal((await request('/pair', { 'X-Bili-Peek-Ticket': ticket, Origin: 'https://evil.example' })).status, 403);
    const exchanges = await Promise.all([request('/pair', { 'X-Bili-Peek-Ticket': ticket }), request('/pair', { 'X-Bili-Peek-Ticket': ticket })]);
    assert.deepEqual(exchanges.map(item => item.status).sort(), [200, 401]);
    assert.deepEqual(exchanges.find(item => item.status === 200).body, { token: config.token, port });
    assert.equal((await request('/pair', { 'X-Bili-Peek-Ticket': ticket })).status, 401);
    const auth = { 'X-Bili-Peek-Token': config.token, 'X-Bili-Peek-Client': 'userscript' };
    for (const action of ['pause', 'resume', 'cancel']) {
      const endpoint = `/jobs/${'a'.repeat(20)}/${action}`;
      assert.equal((await request(endpoint)).status, 401, 'control actions require pairing');
      assert.equal((await request(endpoint, auth)).status, 409, 'ended/missing jobs cannot be controlled');
      assert.equal((await request(endpoint, { ...auth, Origin: 'https://evil.example' })).status, 403);
    }
    assert.equal((await request('/health', auth)).body.ready, true);
    assert.equal(await preparePairing(config, directory), null, 'an already connected browser must not be opened again');
    await stop(); await start();
    assert.equal((await request('/health', auth)).body.ready, true, 'saved pairing still works after a process restart');
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).token, config.token);
    await fs.writeFile(path.join(directory, 'browser-paired.json'), '{}');
    const expiredUrl = await preparePairing(config, directory);
    const expiredTicket = new URLSearchParams(new URL(expiredUrl).hash.slice(1)).get('bili-peek-connect');
    await fs.writeFile(path.join(directory, 'browser-pairing.json'), JSON.stringify({ ticket: expiredTicket, expires: 0 }));
    assert.equal((await request('/pair', { 'X-Bili-Peek-Ticket': expiredTicket })).status, 401);
  } finally { await stop(); await fs.rm(directory, { recursive: true, force: true }); }
});
