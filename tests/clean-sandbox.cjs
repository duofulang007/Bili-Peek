// Test runs create throwaway vaults under tests/export-sandbox and download
// fragments under .local/segment-cache. Neither is cleaned up by the tests
// themselves, so repeated runs grow the working tree by hundreds of MB.
// Called by tests/run-tests.cjs after the suite, and runnable on its own via
// `npm run clean`.
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targets = ['tests/export-sandbox', '.local/segment-cache'];

async function cleanSandbox() {
  for (const relative of targets) {
    // force:true keeps this a no-op when the tests did not create the directory.
    await fs.rm(path.join(root, relative), { recursive: true, force: true });
  }
  return targets;
}

if (require.main === module) {
  cleanSandbox()
    .then(removed => console.log(`已清理测试产物：${removed.join('、')}`))
    .catch(error => { console.error(`清理失败：${error.message}`); process.exitCode = 1; });
}

module.exports = { cleanSandbox };
