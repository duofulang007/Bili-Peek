const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { listFolders, resolveOutput } = require('../helper/vault-paths.cjs');
const { folderMatches } = require('../Bili-Peek.user.js');
const { main } = require('../helper/server.cjs');

test('vault paths search real folders, confine writes and persist defaults only after successful export', async () => {
  const sandbox = path.join(__dirname, 'export-sandbox'); await fs.mkdir(sandbox, { recursive: true });
  const folder = await fs.mkdtemp(path.join(sandbox, 'paths-'));
  const vault = path.join(folder, 'vault'), output = path.join(vault, '网页内容');
  const configFile = path.join(folder, 'config.json'), token = 'b'.repeat(64);
  for (const relative of ['.obsidian', '网页内容', '学习/编程', '学习/语言', '网页内容/Bili-Peek附件']) await fs.mkdir(path.join(vault, relative), { recursive: true });
  const probe = require('node:net').createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { vault, output, ffmpeg: process.execPath, ffprobe: process.execPath, port, token, category: 'preserve' };
  await fs.writeFile(configFile, JSON.stringify(config));
  let server;
  try {
    const listed = await listFolders(config);
    assert.equal(listed.defaultDirectory, '网页内容');
    assert.ok(listed.folders.includes('学习/编程'));
    assert.ok(!listed.folders.some(value => value.includes('.obsidian') || value.includes('Bili-Peek附件')));
    assert.deepEqual(folderMatches(listed.folders, '学编'), ['学习/编程']);
    assert.deepEqual(folderMatches(listed.folders, '学习 语言'), ['学习/语言']);
    assert.deepEqual(folderMatches(listed.folders, '不存在'), []);
    for (const value of ['../outside', 'C:\\outside', '/outside', 'missing', '', 123]) await assert.rejects(resolveOutput(config, value));
    const outside = path.join(folder, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(vault, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveOutput(config, 'linked'), /链接/);
    assert.ok(!(await listFolders(config)).folders.includes('linked'));
    server = await main({ configFile, exporter: async task => {
      if (task.summary === 'fail') throw new Error('expected export failure');
      return { notePath: path.join(await resolveOutput(config, task.outputDirectory), 'note.md') };
    } });
    const request = async (endpoint, body, authenticated = true) => {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { 'X-Bili-Peek-Token': token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/folders', undefined, false)).status, 401);
    assert.equal((await request('/folders')).body.defaultDirectory, '网页内容');
    const task = { id: 'BV1xx411c7mD', part: 1, cid: 123, start: 0, end: 30, tags: ['测试'], subtitles: [], videoOnly: true, videoUrl: 'https://test.bilivideo.com/video', audioUrl: 'https://test.bilivideo.com/audio', outputDirectory: '学习/编程', setDefaultDirectory: true };
    assert.equal((await request('/clips', { ...task, outputDirectory: '../outside' })).status, 400);
    const waitJob = async key => {
      for (let i = 0; i < 100; i++) { const state = (await request('/jobs/' + key)).body; if (['complete', 'failed'].includes(state.state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('job did not finish');
    };
    const job = await request('/clips', task); assert.equal(job.status, 202);
    const completed = await waitJob(job.body.key);
    assert.equal(completed.state, 'complete'); assert.ok(completed.completedAt > 0);
    const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
    assert.equal(persisted.output, path.join(vault, '学习/编程'));
    assert.equal(persisted.token, token); assert.equal(persisted.category, 'preserve');
    assert.equal((await request('/folders')).body.defaultDirectory, '学习/编程');
    const failure = await request('/clips', { ...task, outputDirectory: '学习/语言', summary: 'fail' });
    assert.notEqual(failure.body.key, job.body.key, 'same range in another destination has its own job');
    assert.equal((await waitJob(failure.body.key)).state, 'failed');
    assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).output, persisted.output);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(folder, { recursive: true, force: true });
  }
});
