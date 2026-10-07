const fs = require('node:fs/promises');
const path = require('node:path');

const managers = new Map();
function cacheManager(config = {}) {
  const root = path.resolve(process.env.BILI_PEEK_SEGMENT_CACHE || config.segmentCacheRoot || path.join(__dirname, '../.local/segment-cache'));
  const maxMiB = config.segmentCacheMiB ?? 64, days = config.segmentCacheDays ?? 7;
  if (!Number.isInteger(maxMiB) || maxMiB < 1 || maxMiB > 1024 || !Number.isInteger(days) || days < 1 || days > 365) throw new Error('分片缓存配置无效：容量须为 1–1024 MiB，保留时间须为 1–365 天');
  if (!managers.has(root)) managers.set(root, new SegmentCache(root, maxMiB * 1048576, days * 86400000));
  const manager = managers.get(root);
  if (manager.limit !== maxMiB * 1048576 || manager.maxAge !== days * 86400000) throw new Error('同一缓存目录不能使用不同容量配置');
  return manager;
}

class SegmentCache {
  constructor(root, limit, maxAge) {
    this.root = path.resolve(root); this.limit = limit; this.maxAge = maxAge;
    this.pins = new Map(); this.pending = Promise.resolve();
  }
  // ponytail: serialize short cache bookkeeping; media downloads remain parallel.
  serial(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  async entries() {
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('缓存目录不能是链接');
    const entries = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('缓存目录含未知文件或链接，请先检查，不自动删除');
      const directory = path.join(this.root, entry.name);
      let bytes = 0;
      for (const file of await fs.readdir(directory, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink() || !/^(?:init|\d+)\.bin(?:\.json|\.partial(?:\.json)?)?$/.test(file.name)) throw new Error('分片缓存含未知文件、目录或链接，不自动删除');
        try { bytes += (await fs.stat(path.join(directory, file.name))).size; }
        catch (error) { if (error.code !== 'ENOENT') throw error; } // A pinned download can rename its partial file during inspection.
      }
      const stat = await fs.stat(directory), pin = this.pins.get(entry.name);
      entries.push({ name: entry.name, directory, bytes, reserved: Math.max(bytes, pin?.bytes || 0), used: stat.mtimeMs, pinned: Boolean(pin) });
    }
    return entries.sort((a, b) => a.used - b.used);
  }
  async sweep(reserve = 0, keep) {
    const entries = await this.entries();
    let bytes = entries.reduce((sum, entry) => sum + entry.reserved, 0);
    let removedBytes = 0;
    for (const entry of entries) {
      if (entry.pinned || entry.name === keep) continue;
      if (Date.now() - entry.used <= this.maxAge && bytes + reserve <= this.limit) continue;
      await fs.rm(entry.directory, { recursive: true, force: true });
      bytes -= entry.reserved; removedBytes += entry.bytes;
    }
    return { bytes, removedBytes, limitBytes: this.limit, activeTracks: this.pins.size };
  }
  prune() { return this.serial(() => this.sweep()); }
  status() {
    return this.serial(async () => ({ bytes: (await this.entries()).reduce((sum, entry) => sum + entry.bytes, 0), limitBytes: this.limit, maxAgeDays: this.maxAge / 86400000, activeTracks: this.pins.size }));
  }
  acquire(identity, required, work) {
    return this.serial(async () => {
      if (!/^[a-f0-9]{64}$/.test(identity) || !Number.isSafeInteger(required) || required < 0) throw new Error('缓存预留参数无效');
      // Include existing bytes plus the entire incoming selection: even corrupt
      // old files and partial downloads cannot make writes exceed the budget.
      const entries = await this.entries(), existing = entries.find(entry => entry.name === identity);
      const pin = this.pins.get(identity);
      const reserved = Math.max(existing?.bytes || 0, pin?.bytes || 0) + required;
      const cannotFit = reserved + entries.filter(entry => entry.pinned && entry.name !== identity).reduce((sum, entry) => sum + entry.reserved, 0) > this.limit;
      const { bytes } = await this.sweep(cannotFit ? 0 : reserved - (existing?.reserved || 0), cannotFit ? undefined : identity);
      if (cannotFit || bytes + reserved - (existing?.reserved || 0) > this.limit) {
        const directory = path.join(work, 'segment-transient', identity);
        await fs.mkdir(directory, { recursive: true });
        return { directory, release: () => fs.rm(directory, { recursive: true, force: true }) };
      }
      const directory = path.join(this.root, identity);
      await fs.mkdir(directory, { recursive: true });
      await fs.utimes(directory, new Date(), new Date());
      this.pins.set(identity, { bytes: reserved, users: (pin?.users || 0) + 1 });
      let released = false;
      return { directory, release: () => this.serial(async () => {
        if (released) return;
        released = true;
        const pin = this.pins.get(identity);
        if (--pin.users === 0) this.pins.delete(identity);
        await fs.utimes(directory, new Date(), new Date());
        await this.sweep();
      }) };
    });
  }
}

module.exports = { cacheManager, SegmentCache };
