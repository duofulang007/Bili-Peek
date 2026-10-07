const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportClip, validateTask, keyFor, run } = require('./export.cjs');
const { downloadTracks, TransferControl, cleanError } = require('./segment-download.cjs');
const { consumePairing, fingerprint } = require('./pairing.cjs');
const { recognize } = require('./transcription.cjs');
const { cacheManager } = require('./segment-cache.cjs');
const { resolveOutput, listFolders } = require('./vault-paths.cjs');
const configPath = process.env.BILI_PEEK_CONFIG || path.resolve(__dirname, '../.local/export-config.json');

function signWbi(input) {
  if (!/^[a-f0-9]{64}$/.test(input.key || '') || !input.params || typeof input.params !== 'object') throw new Error('签名参数无效');
  const table = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  const mix = table.map(index => input.key[index]).join('').slice(0, 32);
  const params = { wts: Math.floor(Date.now() / 1000) };
  for (const name of ['bvid', 'aid', 'cid', 'qn', 'fnval', 'fourk']) if (input.params[name] !== undefined) params[name] = String(input.params[name]).replace(/[!'()*]/g, '');
  const query = Object.keys(params).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(params[name])}`).join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + mix).digest('hex');
}

async function main({ configFile = configPath, exporter = exportClip, downloader = downloadTracks } = {}) {
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('请配置至少 32 字符的配对令牌');
  await Promise.all([fs.access(config.ffmpeg), fs.access(config.ffprobe), fs.access(path.join(config.vault, '.obsidian'))]);
  const directory = path.dirname(configFile);
  config.segmentCacheRoot = path.join(directory, 'segment-cache');
  const cache = cacheManager(config);
  config.segmentDownloader = path.resolve(__dirname, '../.tools/N_m3u8DL-RE.exe');
  const segmentAvailable = config.segmentNative !== false || await fs.access(config.segmentDownloader).then(() => true, () => false);
  const routes = new Map(), controls = new Map();
  const jobs = new Map(), active = new Map(), queue = [];
  let browserAcknowledged = 0, ready = false;
  let settingsWrite = Promise.resolve();
  const pump = () => {
    // A shared video's range cache must have only one writer. Other videos can run together.
    while (active.size < 2) {
      const index = queue.findIndex(({ task }) => ![...active.values()].some(other => other.id === task.id && other.cid === task.cid));
      if (index < 0) break;
      const { task, key, control } = queue.splice(index, 1)[0];
      active.set(key, task); jobs.set(key, { state: 'processing', stage: 'prepare', percent: 0 });
      const controlledRun = async (executable, args, timeout, progress) => {
        const c = control.controller();
        try { return await run(executable, args, { ...(typeof timeout === 'object' ? timeout : {}), ...(typeof timeout === 'number' ? { idleMs: timeout } : {}), signal: c.signal }, progress); }
        finally { control.release(c); }
      };
      Promise.resolve().then(() => exporter(task, config, controlledRun, progress => jobs.set(key, { state: 'processing', ...progress }), {
        checkpoint: async () => { await control.wait(); control.canCancel = false; },
        backupNote: async (key, content) => {
          const backups = path.join(directory, 'export-notes');
          await fs.mkdir(backups, { recursive: true });
          try { await fs.writeFile(path.join(backups, key + '.md'), content, { flag: 'wx' }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        },
        recognize: async (video, duration) => {
          const c = control.controller();
          try { return await recognize(video, duration, config, controlledRun, c.signal); }
          finally { control.release(c); }
        },
        download: (task, work, progress) => downloader(task, config, run, progress, control, routes, work)
      })).then(async result => {
        if (task.setDefaultDirectory) {
          const update = settingsWrite.then(async () => {
            const latest = JSON.parse(await fs.readFile(configFile, 'utf8'));
            const output = await resolveOutput(config, task.outputDirectory);
            const temporary = configFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
            try {
              await fs.writeFile(temporary, JSON.stringify({ ...latest, output }, null, 2));
              await fs.rename(temporary, configFile);
              config.output = output;
            } finally { await fs.rm(temporary, { force: true }); }
          });
          settingsWrite = update.catch(() => {});
          try { await update; } catch (error) { result.defaultDirectoryError = cleanError(error); }
        }
        jobs.set(key, { state: 'complete', ...result, completedAt: Date.now() });
        if (result.timings) fs.appendFile(path.resolve(__dirname, '../.local/export-timings.jsonl'), JSON.stringify({ at: new Date().toISOString(), key, duration: result.duration, videoEncoder: result.videoEncoder, hardwareDecode: result.hardwareDecode, timings: result.timings, ...(result.download ? { download: result.download } : {}) }) + '\n').catch(() => {});
      }, error => jobs.set(key, { state: control.cancelled ? 'cancelled' : 'failed', error: cleanError(error) })).finally(() => { active.delete(key); controls.delete(key); pump(); });
    }
    queue.forEach(({ key }, index) => jobs.set(key, { state: 'processing', stage: 'queued', percent: 0, queuePosition: index + 1, canPause: false }));
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== `127.0.0.1:${config.port || 18766}` || (req.headers.origin && req.headers.origin !== 'https://www.bilibili.com')) return send(403, { error: '请求来源无效' });
    for (const [prefix, handler] of routes) if (req.url.startsWith(prefix + '/')) return handler(req, res);
    if (req.method === 'POST' && req.url === '/pair') {
      try { return send(200, await consumePairing(req.headers['x-bili-peek-ticket'], config, directory)); }
      catch { return send(401, { error: '连接凭证无效或已过期，请从 CPod 重新启动连接' }); }
    }
    const supplied = Buffer.from(req.headers['x-bili-peek-token'] || ''), expected = Buffer.from(config.token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: '配对令牌无效' });
    if (req.method === 'GET' && req.url === '/folders') {
      try { return send(200, await listFolders(config)); }
      catch (error) { return send(500, { error: cleanError(error) }); }
    }
    if (req.method === 'GET' && req.url === '/health') {
      if (req.headers['x-bili-peek-client'] === 'userscript' && Date.now() - browserAcknowledged > 10000) {
        try {
          await fs.writeFile(path.join(directory, 'browser-paired.json'), JSON.stringify({ fingerprint: fingerprint(config.token), lastSeen: Date.now() }));
          browserAcknowledged = Date.now();
        } catch { return send(500, { error: '无法保存浏览器连接状态' }); }
      }
      return send(200, { ready, active: active.size > 0 || queue.length > 0, activeCount: active.size, queuedCount: queue.length, pid: process.pid, segmentAvailable, videoEncoder: config.videoEncoder || 'libx264', hardwareDecode: config.hardwareDecode === true && config.videoEncoder === 'h264_nvenc' });
    }
    if (req.method === 'GET' && /^\/jobs\/[a-f0-9]{20}$/.test(req.url)) return send(200, jobs.get(req.url.slice(6)) || { state: 'missing' });
    const action = /^\/jobs\/([a-f0-9]{20})\/(pause|resume|cancel)$/.exec(req.url);
    if (req.method === 'POST' && action) {
      const control = controls.get(action[1]);
      if (!control) return send(409, { error: '任务已结束或不在当前助手中' });
      try {
        const queued = queue.findIndex(item => item.key === action[1]);
        if (queued >= 0) {
          if (action[2] !== 'cancel') return send(409, { error: '排队中的任务尚未开始下载' });
          control.cancel(); queue.splice(queued, 1); controls.delete(action[1]);
          jobs.set(action[1], { state: 'cancelled' }); pump(); return send(200, { cancelled: true, paused: false });
        }
        control[action[2]]();
        const progress = jobs.get(action[1]);
        jobs.set(action[1], { ...progress, paused: control.paused, ...(control.paused ? { bytesPerSecond: 0, etaSeconds: null } : {}) });
        return send(200, { paused: control.paused, cancelled: control.cancelled });
      } catch (error) { return send(409, { error: error.message }); }
    }
    if (req.method !== 'POST' || !['/clips', '/sign-wbi'].includes(req.url)) return send(404, { error: '未找到接口' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4000000) { send(413, { error: '字幕数据过大' }); return; } chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/sign-wbi') return send(200, { query: signWbi(input) });
      const task = validateTask(input);
      const output = await resolveOutput(config, task.outputDirectory);
      task.outputDirectory = path.relative(path.resolve(config.vault), output).split(path.sep).join('/') || '.';
      const key = crypto.createHash('sha256').update(keyFor(task) + '\0' + output).digest('hex').slice(0, 20);
      if (task.downloadEngine && task.downloadEngine !== 'nre') throw new Error('下载方式无效');
      if (task.downloadEngine === 'nre' && !segmentAvailable) throw new Error('分片下载工具尚未安装');
      if (controls.has(key)) return send(202, { key });
      if (queue.length >= 50) return send(429, { error: '等待保存的任务过多，请稍后再试' });
      if (jobs.size >= 100) { const ended = [...jobs.keys()].find(key => !controls.has(key)); if (ended) jobs.delete(ended); }
      const control = new TransferControl(); controls.set(key, control);
      queue.push({ task, key, control }); pump(); send(202, { key });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.requestTimeout = 30000;
  let cacheTimer;
  server.on('close', () => clearInterval(cacheTimer));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '片段助手端口已占用，请检查是否已启动助手。' : error.message); process.exitCode = 1; });
  server.listen(config.port || 18766, '127.0.0.1', async () => {
    try {
      // Bind first: a duplicate helper must never clean a running helper's cache.
      await cache.prune();
      await fs.writeFile(path.join(directory, 'helper.pid'), String(process.pid));
    }
    catch (error) { console.error(error.message); server.close(); process.exitCode = 1; return; }
    ready = true;
    cacheTimer = setInterval(() => cache.prune().catch(error => console.error('分片缓存维护失败：' + cleanError(error))), 600000);
    cacheTimer.unref();
    console.log(`Bili-Peek 助手已启动，保存目录：${config.output}`);
  });
  return server;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, signWbi };
