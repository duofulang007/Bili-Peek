const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { preparePairing } = require('./pairing.cjs');
(async () => {
  const directory = path.resolve(__dirname, '../.local');
  const config = JSON.parse(await fs.readFile(path.join(directory, 'export-config.json'), 'utf8'));
  const url = await preparePairing(config, directory);
  if (!url) return;
  // The URL contains an expiring ticket, never the saved export token.
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
