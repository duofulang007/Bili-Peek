const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SegmentCache } = require('../helper/segment-cache.cjs');

test('automatic cache budget, expiry, active reservations and oversized task isolation', async () => {
  const sandbox = path.join(__dirname, 'export-sandbox');
  await fs.mkdir(sandbox, { recursive: true });
  const folder = await fs.mkdtemp(path.join(sandbox, 'cache-'));
  const root = path.join(folder, 'cache'), work = path.join(folder, 'work');
  const manager = new SegmentCache(root, 1000, 86400000);
  const name = n => String(n).repeat(64);
  const seed = async (n, bytes, age) => {
    const directory = path.join(root, name(n));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'init.bin'), Buffer.alloc(bytes));
    const time = new Date(Date.now() - age);
    await fs.utimes(directory, time, time);
    return directory;
  };
  try {
    const old = await seed(1, 600, 30000), recent = await seed(2, 600, 10000);
    await manager.prune();
    await assert.rejects(fs.access(old), { code: 'ENOENT' });
    await fs.access(recent);
    assert.equal((await manager.status()).bytes, 600);
    const expired = await seed(3, 100, 2 * 86400000);
    await manager.prune();
    await assert.rejects(fs.access(expired), { code: 'ENOENT' });

    const [a, b] = await Promise.all([manager.acquire(name(4), 700, work), manager.acquire(name(5), 700, work)]);
    assert.equal(a.directory, path.join(root, name(4)));
    assert.equal(b.directory, path.join(work, 'segment-transient', name(5)));
    await fs.writeFile(path.join(a.directory, 'init.bin'), Buffer.alloc(650));
    await fs.writeFile(path.join(b.directory, 'init.bin'), Buffer.alloc(700));
    const ancient = new Date(0);
    await fs.utimes(a.directory, ancient, ancient);
    await manager.prune(); // Paused/in-flight tracks stay pinned even when old.
    await fs.access(path.join(a.directory, 'init.bin'));
    assert.equal((await manager.status()).activeTracks, 1);
    assert.ok((await manager.status()).bytes <= 1000);
    await b.release();
    await assert.rejects(fs.access(b.directory), { code: 'ENOENT' });
    await a.release(); await a.release();
    assert.equal((await manager.status()).activeTracks, 0);

    const oversized = await manager.acquire(name(6), 5000, work);
    await fs.access(a.directory); // An oversized task must not evict useful cache for nothing.
    await oversized.release();
    const reuse = await manager.acquire(name(4), 100, work);
    assert.equal(reuse.directory, a.directory);
    await reuse.release();

    const nestedNote = path.join(a.directory, 'note.md');
    await fs.writeFile(nestedNote, 'keep note');
    await assert.rejects(manager.prune(), /未知/);
    assert.equal(await fs.readFile(nestedNote, 'utf8'), 'keep note');
    await fs.unlink(nestedNote);

    const malicious = path.join(root, 'user-note.md');
    await fs.writeFile(malicious, 'keep');
    await assert.rejects(manager.prune(), /未知/);
    assert.equal(await fs.readFile(malicious, 'utf8'), 'keep');
    await assert.rejects(manager.acquire('../escape', 1, work), /参数无效/);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
