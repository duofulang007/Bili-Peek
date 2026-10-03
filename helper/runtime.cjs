const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.local');
function validate(code, loader) {
  const header = code.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m)?.[0];
  const version = header?.match(/^\/\/ @version\s+(\S+)/m)?.[1];
  if (!version) throw new Error('Runtime metadata missing');
  for (const line of header.split('\n')) {
    if (/^\/\/ @(grant|connect|match|run-at|noframes)\b/.test(line) && !loader.split('\n').some(item => item.trim() === line.trim())) {
      throw new Error('加载器权限不兼容，请先更新加载器：' + line.trim());
    }
  }
  new Function(code);
  return { version, code, sha256: crypto.createHash('sha256').update(code).digest('hex') };
}
async function publish(target = directory, sourceRoot = root, expectedHash) {
  const code = await fs.readFile(path.join(sourceRoot, 'Bili-Peek.user.js'), 'utf8');
  const loader = await fs.readFile(path.join(sourceRoot, 'Bili-Peek-loader.user.js'), 'utf8');
  const runtime = validate(code, loader);
  if (expectedHash && runtime.sha256 !== expectedHash) throw new Error('源码在校验后发生变化，未切换版本');
  await fs.mkdir(target, { recursive: true });
  const current = path.join(target, 'runtime.json');
  try {
    const previous = await fs.readFile(current, 'utf8');
    if (JSON.parse(previous).sha256 === runtime.sha256) return runtime;
    await fs.writeFile(path.join(target, 'runtime.previous.json'), previous);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(target, 'runtime-' + crypto.randomUUID() + '.tmp');
  try { await fs.writeFile(temporary, JSON.stringify(runtime)); await fs.rename(temporary, current); }
  finally { await fs.rm(temporary, { force: true }); }
  return runtime;
}
function createServer(target = directory, sourceRoot = root) {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || '') || request.method !== 'GET') { response.writeHead(403); response.end(); return; }
    try {
      if (request.url === '/runtime') {
        const content = await fs.readFile(path.join(target, 'runtime.json'));
        response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(content);
      } else if (request.url === '/Bili-Peek-loader.user.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(await fs.readFile(path.join(sourceRoot, 'Bili-Peek-loader.user.js')));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(503); response.end('Published runtime unavailable'); }
  });
}
if (require.main === module) {
  if (process.argv.includes('--publish')) {
    const hashIndex = process.argv.indexOf('--sha256');
    publish(directory, root, hashIndex < 0 ? undefined : process.argv[hashIndex + 1]).then(runtime => console.log('PUBLISHED_RUNTIME ' + runtime.version), error => { console.error(error.message); process.exitCode = 1; });
  }
  else createServer().listen(18767, '127.0.0.1').on('error', error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { validate, publish, createServer };
