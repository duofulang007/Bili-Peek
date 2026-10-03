const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const { validate, publish, createServer } = require('../helper/runtime.cjs');
const root = path.resolve(__dirname, '..');

test('publishing preserves the last verified runtime and rejects incompatible grants', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-runtime-'));
  try {
    const code = await fs.readFile(path.join(root, 'Bili-Peek.user.js'), 'utf8');
    const loader = await fs.readFile(path.join(root, 'Bili-Peek-loader.user.js'), 'utf8');
    const previous = validate(code + '\n// previous', loader);
    await fs.writeFile(path.join(temporary, 'runtime.json'), JSON.stringify(previous));
    const current = await publish(temporary);
    assert.equal(JSON.parse(await fs.readFile(path.join(temporary, 'runtime.previous.json'))).sha256, previous.sha256);
    assert.equal(current.sha256, crypto.createHash('sha256').update(code).digest('hex'));
    await assert.rejects(publish(temporary, root, '0'.repeat(64)), /源码在校验后发生变化/);
    assert.throws(() => validate(code.replace('// @grant        GM_getValue', '// @grant        GM_deleteValue'), loader), /权限不兼容/);
    assert.equal(JSON.parse(await fs.readFile(path.join(temporary, 'runtime.json'))).sha256, current.sha256);
    const server = createServer(temporary);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await (await fetch(url + '/runtime')).json()).sha256, current.sha256);
      assert.equal(await (await fetch(url + '/Bili-Peek-loader.user.js')).text(), loader);
      const status = await new Promise((resolve, reject) => http.get(url + '/runtime', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
      assert.equal(status, 403);
      assert.equal((await fetch(url + '/../../.local/export-config.json')).status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('loader uses verified code, retains pairing storage and falls back offline without executing corruption', async () => {
  const loader = await fs.readFile(path.join(root, 'Bili-Peek-loader.user.js'), 'utf8');
  const code = "GM_setValue('executed-with-token', GM_getValue('export-token'));";
  const runtime = { version: 'test', code, sha256: crypto.createHash('sha256').update(code).digest('hex') };
  const storage = new Map([['export-token', 'existing-pairing']]);
  let offline = false, corrupt = false, alerts = 0;
  const state = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, Uint8Array, console, unsafeWindow: {},
    GM_registerMenuCommand() {}, GM_setClipboard() {},
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value), alert: () => { alerts++; },
    GM_xmlhttpRequest: options => offline ? options.onerror() : options.onload({ status: 200, responseText: JSON.stringify(corrupt ? { ...runtime, code: 'throw new Error("corrupt")' } : runtime) })
  });
  await vm.runInContext(loader, state);
  assert.equal(storage.get('executed-with-token'), 'existing-pairing');
  assert.equal(storage.get('cpod-verified-runtime').sha256, runtime.sha256);
  storage.delete('executed-with-token'); offline = true;
  await vm.runInContext(loader, state);
  assert.equal(storage.get('executed-with-token'), 'existing-pairing');
  offline = false; corrupt = true; storage.delete('executed-with-token');
  await vm.runInContext(loader, state);
  assert.equal(storage.get('executed-with-token'), 'existing-pairing');
  storage.delete('cpod-verified-runtime'); storage.delete('executed-with-token');
  await vm.runInContext(loader, state);
  assert.equal(storage.has('executed-with-token'), false); assert.equal(alerts, 1);
});
