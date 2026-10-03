const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportClip, validateTask, keyFor } = require('./export.cjs');
const { consumePairing, fingerprint } = require('./pairing.cjs');
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

async function main() {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('请配置至少 32 字符的配对令牌');
  await Promise.all([fs.access(config.ffmpeg), fs.access(config.ffprobe), fs.access(path.join(config.vault, '.obsidian'))]);
  const directory = path.dirname(configPath);
  const jobs = new Map(); let active = null, browserAcknowledged = 0, ready = false;
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== `127.0.0.1:${config.port || 18766}` || (req.headers.origin && req.headers.origin !== 'https://www.bilibili.com')) return send(403, { error: '请求来源无效' });
    if (req.method === 'POST' && req.url === '/pair') {
      try { return send(200, await consumePairing(req.headers['x-bili-peek-ticket'], config, directory)); }
      catch { return send(401, { error: '连接凭证无效或已过期，请从 CPod 重新启动连接' }); }
    }
    const supplied = Buffer.from(req.headers['x-bili-peek-token'] || ''), expected = Buffer.from(config.token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: '配对令牌无效' });
    if (req.method === 'GET' && req.url === '/health') {
      if (req.headers['x-bili-peek-client'] === 'userscript' && Date.now() - browserAcknowledged > 10000) {
        try {
          await fs.writeFile(path.join(directory, 'browser-paired.json'), JSON.stringify({ fingerprint: fingerprint(config.token), lastSeen: Date.now() }));
          browserAcknowledged = Date.now();
        } catch { return send(500, { error: '无法保存浏览器连接状态' }); }
      }
      return send(200, { ready, active: Boolean(active), pid: process.pid });
    }
    if (req.method === 'GET' && /^\/jobs\/[a-f0-9]{20}$/.test(req.url)) return send(200, jobs.get(req.url.slice(6)) || { state: 'missing' });
    if (req.method !== 'POST' || !['/clips', '/sign-wbi'].includes(req.url)) return send(404, { error: '未找到接口' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4000000) { send(413, { error: '字幕数据过大' }); return; } chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/sign-wbi') return send(200, { query: signWbi(input) });
      const task = validateTask(input), key = keyFor(task);
      if (active === key) return send(202, { key });
      if (active) return send(409, { error: '另一片段正在保存，请完成后重试' });
      if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
      active = key; jobs.set(key, { state: 'processing' }); send(202, { key });
      exportClip(task, config, undefined, progress => jobs.set(key, { state: 'processing', ...progress })).then(result => {
        jobs.set(key, { state: 'complete', ...result });
        if (result.timings) fs.appendFile(path.resolve(__dirname, '../.local/export-timings.jsonl'), JSON.stringify({ at: new Date().toISOString(), key, duration: result.duration, timings: result.timings }) + '\n').catch(() => {});
      }, error => jobs.set(key, { state: 'failed', error: error.message })).finally(() => { active = null; });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.requestTimeout = 30000;
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '片段助手端口已占用，请检查是否已启动助手。' : error.message); process.exitCode = 1; });
  server.listen(config.port || 18766, '127.0.0.1', async () => {
    try { await fs.writeFile(path.join(directory, 'helper.pid'), String(process.pid)); }
    catch (error) { console.error(error.message); server.close(); process.exitCode = 1; return; }
    ready = true;
    console.log(`Bili-Peek 助手已启动，保存目录：${config.output}`);
  });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, signWbi };
