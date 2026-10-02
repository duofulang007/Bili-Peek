const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.BILI_PEEK_PREVIEW_PORT || 8765);

// A local, silent 160-second media sample exercises real browser seeking.
const rate = 8000;
const samples = 160 * rate;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);

const routes = {
  '/obsidian-preview.html': [path.join(__dirname, 'obsidian-preview.html'), 'text/html; charset=utf-8'],
  '/Bili-Peek.user.js': [path.join(root, 'Bili-Peek.user.js'), 'application/javascript; charset=utf-8'],
  '/preview.js': [path.join(__dirname, 'preview.js'), 'application/javascript; charset=utf-8']
};

function varint(value) {
  value = BigInt(value); const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
function field(number, value, text = false) {
  if (!text) return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const subjects = ['内存价格上涨', '512GB内存', '金条比内存便宜', 'DDR5内存涨价', '服务器内存容量', '美光发布预测', '黄金价格', '普通电脑用不上', '三星内存', 'HBM带宽', 'ECC纠错', 'DDR4价格', '主板支持容量', '内存厂商', '硬盘容量', '这条金条多少钱', '512GB服务器内存', '电脑配置升级'];
function mockDanmaku(part) {
  const rows = [];
  for (let second = 0; second < 160; second++) {
    const count = second < 8 ? 28 - second * 3 : Math.abs(second - 100) < 5 ? 12 - Math.abs(second - 100) * 2 : second % 7 === 0 ? 5 : second % 3 === 0 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const text = part === '1002' ? ['第二部分内存测试', '性能提升', '带宽测试结果'][i % 3] : subjects[(second + i) % subjects.length];
      const elem = Buffer.concat([field(1, BigInt(rows.length) + 9007199254740993n), field(2, second * 1000 + i * 10), field(3, 1), field(7, text, true)]);
      rows.push(field(1, elem, true));
    }
  }
  return Buffer.concat(rows);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const pathname = url.pathname;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (pathname === '/mock/x/web-interface/view') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code:0,data:{aid:123,title:'模拟内存视频',pages:[{page:1,cid:1001,duration:160},{page:2,cid:1002,duration:160},{page:3,cid:1003,duration:160},{page:4,cid:1004,duration:160}]}})); return;
  }
  if (pathname === '/mock/x/v2/dm/web/seg.so') {
    response.setHeader('Content-Type', 'application/octet-stream'); response.end(mockDanmaku(url.searchParams.get('oid'))); return;
  }
  if (pathname === '/silent.wav') {
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    if (start > end || start >= wav.length) { response.writeHead(416, { 'Content-Range': `bytes */${wav.length}` }); response.end(); return; }
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', end - start + 1);
    if (range) response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${wav.length}` });
    response.end(wav.subarray(start, end + 1));
    return;
  }
  const entry = routes[pathname];
  if (entry) {
    response.setHeader('Content-Type', entry[1]);
    fs.createReadStream(entry[0]).pipe(response);
    return;
  }
  if (/^\/video\/BVLocalPreview\/?$/.test(pathname)) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    fs.createReadStream(path.join(__dirname, 'preview.html')).pipe(response);
    return;
  }
  if (pathname === '/') { response.writeHead(302, { Location: '/video/BVLocalPreview/' }); response.end(); return; }
  response.writeHead(404); response.end('Not found');
});
server.listen(port, '127.0.0.1', () => console.log(`Bili-Peek local preview: http://127.0.0.1:${port}/video/BVLocalPreview/`));

