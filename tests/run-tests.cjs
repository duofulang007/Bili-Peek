// Runs the Node regression suite, then reclaims the throwaway vaults and
// fragment caches the tests leave behind. Cleaning up after the suite (rather
// than inside each test) keeps the tests focused and still stops the working
// tree from growing by hundreds of MB on every run.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { cleanSandbox } = require('./clean-sandbox.cjs');

const root = path.resolve(__dirname, '..');
const suites = [
  'core', 'data', 'export', 'watch', 'quality', 'obsidian-player',
  'memory', 'helper-control', 'runtime', 'segment-download', 'segment-cache', 'concurrent-jobs', 'transcription', 'vault-paths'
].map(name => `tests/${name}.test.cjs`);

const child = spawn(process.execPath, ['--test', ...suites], { stdio: 'inherit', cwd: root });
child.on('close', async code => {
  // Always clean, pass or fail: a failing run leaves the most debris.
  try { await cleanSandbox(); } catch (error) { console.error(`清理失败：${error.message}`); }
  process.exitCode = code;
});
