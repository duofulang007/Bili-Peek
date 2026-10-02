const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, '.local/export-config.json'), 'utf8'));
async function ready() {
  try { const response = await fetch(`http://127.0.0.1:${config.port}/health`, { headers: { 'X-Bili-Peek-Token': config.token }, signal: AbortSignal.timeout(1000) }); return response.ok && (await response.json()).ready; } catch { return false; }
}
(async () => {
  if (await ready()) { console.log('Bili-Peek helper is already running.'); return; }
  const log = fs.openSync(path.join(root, '.local/helper.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log], shell: false });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  fs.closeSync(log); child.unref();
  for (let i = 0; i < 20; i++) { if (await ready()) { console.log('Bili-Peek helper is running in the background. You can close this window.'); return; } await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('Helper did not become ready. See .local/helper.log.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
