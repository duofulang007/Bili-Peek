const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const config = JSON.parse(await fs.readFile(path.join(root, '.local/export-config.json'), 'utf8'));
  async function health() {
    try { return await (await fetch(`http://127.0.0.1:${config.port}/health`, { headers: { 'X-Bili-Peek-Token': config.token }, signal: AbortSignal.timeout(1000) })).json(); } catch { return null; }
  }
  const initial = await health();
  if (initial?.active) throw new Error('Export active; do not test');
  const resultPath = path.join(root, '.local/pipe-test-result.json');
  function action(name) {
    return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, '.apex/runner.ps1'), '-Action', name, '-ResultPath', resultPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  async function stop() { const child = action('stop'); child.stdout.resume(); child.stderr.resume(); const [code] = await once(child, 'close'); if (code) throw new Error('Stop failed'); }
  let child;
  try {
    if (initial?.ready) await stop();
    await fs.rm(resultPath, { force: true });
    const began = Date.now(); child = action('run');
    child.stdout.resume(); child.stderr.resume();
    let exited = false, closed = false, exitCode;
    child.on('exit', code => { exited = true; exitCode = code; console.log(`RUN_EXIT code=${code} ms=${Date.now()-began}`); });
    child.on('close', code => { closed = true; console.log(`RUN_PIPES_CLOSED code=${code} ms=${Date.now()-began}`); });
    for (let i=0; i<50 && !exited; i++) await wait(100);
    await wait(1500);
    console.log(`BEFORE_STOP exited=${exited} pipesClosed=${closed} resultExists=${await fs.access(resultPath).then(()=>true,()=>false)}`);
    const completedBeforeStop = exited && closed;
    const readyBeforeStop = (await health())?.ready;
    const stopBegan = Date.now(); await stop(); console.log(`STOP_MS=${Date.now()-stopBegan}`);
    await wait(300);
    if (!exited || !closed) throw new Error('Runner or pipes did not finish');
    if (!completedBeforeStop) throw new Error('CPod output pipes remain open until helper stops');
    assert.equal(exitCode, 0);
    assert.equal(readyBeforeStop, true, 'helper must remain running after launcher and pipes close');
  } finally {
    await stop();
    if (initial?.ready) { const restore = action('run'); restore.stdout.resume(); restore.stderr.resume(); await once(restore, 'exit'); restore.stdout.destroy(); restore.stderr.destroy(); }
    await fs.rm(resultPath, { force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode=1; });
