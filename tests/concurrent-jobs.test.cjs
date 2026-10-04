const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { main } = require('../helper/server.cjs');

test('real HTTP queue runs two videos, isolates controls, cancels queued jobs and preserves duplicate jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-concurrent-'));
  const configFile = path.join(dir, 'config.json');
  const token = 'c'.repeat(64), started = [], finish = new Map();
  await fs.mkdir(path.join(dir, '.obsidian'));
  // Pick an unused local port, keeping the same server host validation as production.
  const probe = require('node:net').createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await fs.writeFile(configFile, JSON.stringify({ vault: dir, output: dir, ffmpeg: process.execPath, ffprobe: process.execPath, port, token }));
  const server = await main({ configFile, downloader: async (task, config, run, progress, control) => {
    control.canPause = true;
    progress({ stage: 'download', percent: 30, canPause: true });
    await new Promise(resolve => finish.set(task.cid, resolve));
    await control.wait();
  }, exporter: async (task, config, run, progress, services) => {
    started.push(task.cid);
    await services.download(task, dir, progress);
    await services.checkpoint();
    return { duration: 10 };
  }});
  const request = async (endpoint, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Bili-Peek-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const task = cid => ({ id: 'BV1aJ7rzaE9C', part: 1, cid, start: 0, end: 10, title: `video ${cid}`, tags: ['test'], videoOnly: true, subtitles: [], videoUrl: 'https://test.bilivideo.com/video', audioUrl: 'https://test.bilivideo.com/audio' });
  try {
    const a = await request('/clips', task(1)), b = await request('/clips', task(2));
    assert.equal(a.status, 202); assert.equal(b.status, 202, 'second video must start without rejecting it');
    assert.deepEqual(started, [1, 2]);
    const overlap = await request('/clips', { ...task(1), start: 1, end: 11 });
    assert.equal(overlap.status, 202);
    assert.equal((await request(`/jobs/${overlap.body.key}`)).body.stage, 'queued', 'same-video cache writers must not overlap');
    assert.deepEqual(started, [1, 2]);
    await request(`/jobs/${overlap.body.key}/cancel`, {});
    const c = await request('/clips', task(3)), d = await request('/clips', task(4));
    assert.equal(c.status, 202); assert.equal(d.status, 202);
    assert.equal((await request(`/jobs/${c.body.key}`)).body.stage, 'queued');
    assert.equal((await request('/clips', task(1))).body.key, a.body.key);
    assert.deepEqual(started, [1, 2], 'duplicates do not launch another export');
    assert.equal((await request(`/jobs/${a.body.key}/pause`, {})).status, 200);
    assert.equal((await request(`/jobs/${a.body.key}`)).body.paused, true);
    assert.notEqual((await request(`/jobs/${b.body.key}`)).body.paused, true);
    assert.equal((await request(`/jobs/${a.body.key}/resume`, {})).status, 200);
    await request(`/jobs/${c.body.key}/cancel`, {});
    assert.equal((await request(`/jobs/${c.body.key}`)).body.state, 'cancelled');
    finish.get(1)();
    for (let i = 0; i < 50 && !started.includes(4); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(started, [1, 2, 4]);
    const health = (await request('/health')).body;
    assert.equal(health.activeCount, 2); assert.equal(health.queuedCount, 0);
    finish.get(2)(); finish.get(4)();
    for (let i = 0; i < 50 && (await request('/health')).body.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await request('/health')).body.active, false);
  } finally {
    for (const done of finish.values()) done();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
