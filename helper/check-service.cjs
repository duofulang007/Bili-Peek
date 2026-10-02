const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname, '../.local/export-config.json'), 'utf8'));
(async () => {
  const url = `http://127.0.0.1:${config.port}/health`;
  const denied = await fetch(url);
  if (denied.status !== 401) throw new Error('未配对请求没有被拒绝');
  const response = await fetch(url, { headers: { 'X-Bili-Peek-Token': config.token } });
  if (!response.ok || !(await response.json()).ready) throw new Error('助手未就绪');
  console.log('PASS: 助手已就绪，未配对请求被拒绝。');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
