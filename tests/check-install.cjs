const fs = require('node:fs');
const path = require('node:path');
const url = process.argv[2] || 'http://127.0.0.1:8765/Bili-Peek.user.js';
(async () => {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const script = await response.text();
  const expected = fs.readFileSync(path.join(__dirname, '..', 'Bili-Peek.user.js'), 'utf8');
  if (script !== expected || !script.startsWith('// ==UserScript==')) throw new Error('安装入口没有返回当前脚本');
  console.log('PASS: 安装入口返回当前 Bili-Peek 油猴脚本（HTTP 200）。');
})().catch(error => {
  console.error(`FAIL: 安装入口不可用：${error.cause?.code || error.message}`);
  process.exitCode = 1;
});
