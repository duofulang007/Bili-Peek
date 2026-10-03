const fs = require('node:fs/promises');
const { unlinkSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fingerprint = token => crypto.createHash('sha256').update(token).digest('hex');
async function preparePairing(config, directory) {
  try {
    const paired = JSON.parse(await fs.readFile(path.join(directory, 'browser-paired.json'), 'utf8'));
    if (paired.fingerprint === fingerprint(config.token) && Date.now() - paired.lastSeen < 20000) return null;
  } catch {}
  const ticket = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(path.join(directory, 'browser-pairing.json'), JSON.stringify({ ticket, expires: Date.now() + 120000 }));
  return `https://www.bilibili.com/#bili-peek-connect=${ticket}&port=${config.port || 18766}`;
}
async function consumePairing(ticket, config, directory) {
  if (!/^[a-f0-9]{64}$/.test(ticket || '')) throw new Error('连接凭证无效');
  const filename = path.join(directory, 'browser-pairing.json');
  const pairing = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (pairing.expires < Date.now() || pairing.ticket !== ticket) throw new Error('连接凭证已过期，请从 CPod 重新启动');
  // Consume synchronously before yielding: concurrent readers cannot both win.
  unlinkSync(filename);
  return { token: config.token, port: config.port || 18766 };
}
module.exports = { preparePairing, consumePairing, fingerprint };
