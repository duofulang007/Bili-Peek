// Experimental bridge: Bilibili SIDX -> selected fragments -> pinned N_m3u8DL-RE.
// The existing helper owns the HTTP listener; this module never opens another port.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sourceHealth = new Map();
function downloadThreads(name, duration, pending, override) {
  const bytes = pending.reduce((n, item) => n + Math.max(0, item.size - (item.partialBytes || 0)), 0);
  const mib = bytes / 1048576;
  if (!bytes) return 0;
  const desired = name === 'audio' ? (mib >= 4 && duration >= 180 ? 4 : mib > 1 ? 2 : 1)
    : (duration >= 600 || mib >= 256 ? 16 : duration >= 180 || mib >= 96 ? 12 : duration >= 60 || mib >= 32 ? 8 : 4);
  const configured = name === 'video' && Number.isInteger(override) && override > 0 ? Math.min(16, override) : desired;
  // Tiny uncached tails should not open the pool planned for the original full clip.
  return Math.min(pending.length, configured, Math.max(1, Math.ceil(bytes / (name === 'audio' ? 262144 : 1048576))));
}
function sourceHealthKey(value) { const url = new URL(value); return url.hostname + '/' + crypto.createHash('sha256').update(url.pathname).digest('hex').slice(0, 16); }
function rememberSourceFailure(url, error) {
  if (!/timeout|timed out|fetch failed|HTTP 5\d\d|60 秒/i.test(String(error.message || error))) return;
  const host = sourceHealthKey(url), previous = sourceHealth.get(host);
  sourceHealth.delete(host);
  sourceHealth.set(host, { failures: (previous?.until > Date.now() ? previous.failures : 0) + 1, until: Date.now() + 180000 });
  if (sourceHealth.size > 32) sourceHealth.delete(sourceHealth.keys().next().value);
}

function parseRange(text) {
  const match = /^(\d+)-(\d+)$/.exec(text || '');
  if (!match) throw new Error('初始化或索引字节范围无效');
  const offset = Number(match[1]), end = Number(match[2]), size = end - offset + 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || size <= 0 || size > 8 * 1024 * 1024) throw new Error('初始化或索引字节范围过大或无效');
  return { offset, size };
}
function parseSidx(buffer, baseOffset) {
  let pos = 0;
  while (pos + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(pos), header = 8;
    if (size === 1) { if (pos + 16 > buffer.length) break; size = Number(buffer.readBigUInt64BE(pos + 8)); header = 16; }
    if (!Number.isSafeInteger(size) || size < header || pos + size > buffer.length) throw new Error('索引截断或大小无效');
    if (buffer.toString('ascii', pos + 4, pos + 8) !== 'sidx') { pos += size; continue; }
    const end = pos + size;
    let p = pos + header;
    const need = n => { if (p + n > end) throw new Error('SIDX 索引截断'); };
    need(12); const version = buffer[p], timescale = buffer.readUInt32BE(p + 8); p += 12;
    if (![0, 1].includes(version) || !timescale) throw new Error('SIDX 版本或时基不受支持');
    need(version ? 16 : 8);
    const earliest = version ? Number(buffer.readBigUInt64BE(p)) : buffer.readUInt32BE(p);
    const first = version ? Number(buffer.readBigUInt64BE(p + 8)) : buffer.readUInt32BE(p + 4); p += version ? 16 : 8;
    need(4); const count = buffer.readUInt16BE(p + 2); p += 4;
    if (!count || count > 20000 || !Number.isSafeInteger(earliest) || !Number.isSafeInteger(first)) throw new Error('SIDX 时间或条目数量无效');
    let offset = baseOffset + end + first, time = earliest / timescale;
    const segments = [];
    for (let i = 0; i < count; i++) {
      need(12); const ref = buffer.readUInt32BE(p), ticks = buffer.readUInt32BE(p + 4), sap = buffer.readUInt32BE(p + 8); p += 12;
      if (ref >>> 31) throw new Error('嵌套 SIDX 暂不支持，请使用原下载方式');
      const length = ref & 0x7fffffff, duration = ticks / timescale;
      if (!length || length > 64 * 1024 * 1024 || !duration || !Number.isSafeInteger(offset + length)) throw new Error('SIDX 分片大小或时长无效');
      segments.push({ offset, size: length, start: time, duration, sap: Boolean(sap >>> 31) && ((sap >>> 28) & 7) <= 2 && (sap & 0x0fffffff) === 0 });
      offset += length; time += duration;
    }
    return { segments, end: time, timescale };
  }
  throw new Error('未找到 SIDX，分片试验停止，请使用原下载方式');
}
function selectSegments(index, start, end) {
  const list = index.segments;
  let first = list.findIndex(s => s.start + s.duration > start);
  if (first < 0 || end <= list[0].start || start < list[0].start - 1) throw new Error('选区不在索引覆盖范围内');
  while (first > 0 && !list[first].sap) first--;
  if (!list[first].sap) throw new Error('没有可独立解码的起始分片');
  return list.slice(first).filter(s => s.start < end);
}
function makePlaylist(base, segments) {
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map(s => s.duration)))}`, `#EXT-X-MAP:URI="${base}/init"`, ...segments.flatMap(s => [`#EXTINF:${s.duration},`, `${base}/${s.offset}`]), '#EXT-X-ENDLIST', ''].join('\n');
}
function validateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)bilivideo\.(com|cn)$/.test(url.hostname) || (url.port && url.port !== '443')) throw new Error('分片源地址无效');
  return url.href;
}
function cleanError(error) {
  return String(error.message || error).replace(/The operation was aborted due to timeout/gi, '请求超时，请检查网络后重试').replace(/https?:\/\/[^\s"'<>]+/g, '[媒体地址]').slice(-1500);
}
class TransferControl {
  constructor() { this.paused = false; this.cancelled = false; this.canPause = false; this.canCancel = true; this.controllers = new Set(); this.waiters = []; }
  controller() { const c = new AbortController(); this.controllers.add(c); if (this.cancelled || this.paused) c.abort(new Error(this.cancelled ? '任务已取消' : '任务已暂停')); return c; }
  release(c) { this.controllers.delete(c); }
  pause() { if (!this.canPause || this.cancelled) throw new Error('当前阶段不能暂停'); this.paused = true; for (const c of this.controllers) c.abort(new Error('任务已暂停')); }
  resume() { if (this.cancelled) throw new Error('任务已取消'); this.paused = false; for (const wake of this.waiters.splice(0)) wake(); }
  cancel() { if (!this.canCancel) throw new Error('正在提交文件，请等待保存结果'); this.cancelled = true; for (const c of this.controllers) c.abort(new Error('任务已取消')); for (const wake of this.waiters.splice(0)) wake(); }
  async wait() { if (this.paused && !this.cancelled) await new Promise(resolve => this.waiters.push(resolve)); if (this.cancelled) throw new Error('任务已取消'); }
}

async function rangedFetch(url, range, signal, fetcher = fetch) {
  validateUrl(url);
  const response = await fetcher(url, { redirect: 'error', headers: { Range: `bytes=${range.offset}-${range.offset + range.size - 1}`, Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, signal });
  const contentRange = response.headers.get('content-range');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
  if (response.status !== 206 || !match || !Number.isSafeInteger(Number(match[3])) || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.size - 1 || Number(match[3]) <= Number(match[2]) || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
    await response.body?.cancel(); throw new Error(`源服务器未正确返回选区字节范围（HTTP ${response.status}），未下载整条轨道`);
  }
  return response;
}
async function readIndex(url, range, fetcher, signal, onBytes = () => {}) {
  const response = await rangedFetch(url, range, signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), fetcher);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { onBytes(chunk.length); size += chunk.length; if (size > range.size) throw new Error('范围响应超出范围'); chunks.push(chunk); }
  if (size !== range.size) throw new Error('索引响应不完整');
  return Buffer.concat(chunks);
}
function sourceCandidates(task, name) {
  const urls = [task[`${name}Url`], ...(Array.isArray(task[`${name}Urls`]) ? task[`${name}Urls`].slice(0, 6) : [])];
  const candidates = [...new Set(urls.flatMap(url => { try { return [validateUrl(url)]; } catch { return []; } }))].slice(0, 3);
  const healthy = candidates.filter(url => { const state = sourceHealth.get(sourceHealthKey(url)); return !state || state.until <= Date.now() || state.failures < 2; });
  return healthy.length ? healthy : candidates;
}
async function loadMetadata(url, init, range, fetcher, control, onBytes, { timeoutMs = 30000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await control.wait(); const c = control.controller();
    try {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(timeoutMs)]);
      let buffer, initBuffer;
      if (init.offset + init.size === range.offset) {
        const combined = await readIndex(url, { offset: init.offset, size: init.size + range.size }, fetcher, signal, onBytes);
        initBuffer = combined.subarray(0, init.size); buffer = combined.subarray(init.size);
      } else {
        buffer = await readIndex(url, range, fetcher, signal, onBytes);
        initBuffer = await readIndex(url, init, fetcher, signal, onBytes);
      }
      parseSidx(buffer, range.offset);
      return { url, buffer, initBuffer };
    } catch (error) {
      if (control.cancelled || c.signal.aborted) throw error;
      rememberSourceFailure(url, error);
      if (attempt >= retries || !/timeout|timed out|fetch failed|HTTP (?:429|5\d\d)/i.test(String(error.message || error))) throw error;
    } finally { control.release(c); }
  }
}
async function rankSources(urls, metadata, init, range, segment, fetcher, control, onBytes) {
  await control.wait();
  if (urls.length < 2) return [{ url: metadata.url, bytesPerSecond: 0 }];
  const probeRange = { offset: segment.offset, size: Math.min(segment.size, 1048576) };
  const results = await Promise.allSettled(urls.map(async url => {
    const other = url === metadata.url ? metadata : await loadMetadata(url, init, range, fetcher, control, onBytes, { timeoutMs: 8000, retries: 0 });
    if (!other.buffer.equals(metadata.buffer) || !other.initBuffer.equals(metadata.initBuffer)) throw new Error('备用源的轨道索引或初始化段不一致');
    const c = control.controller(), started = performance.now();
    try {
      const data = await readIndex(url, probeRange, fetcher, AbortSignal.any([c.signal, AbortSignal.timeout(8000)]), onBytes);
      return { url, data, bytesPerSecond: data.length / Math.max(.001, (performance.now() - started) / 1000) };
    } finally { control.release(c); }
  }));
  await control.wait();
  const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!good.length) throw new Error(`同画质主备源测速均失败：${results.map(r => cleanError(r.reason)).join('；')}。请刷新视频地址后重试`);
  const reference = good.find(r => r.url === metadata.url) || good[0];
  return good.filter(r => r.data.equals(reference.data)).sort((a, b) => b.bytesPerSecond - a.bytesPerSecond).map(({ data, ...source }) => source);
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadTracks(task, config, runner, onProgress, control, routes, work, fetcher = fetch) {
  const began = performance.now(); let received = 0, committed = 0;
  const inflight = new Map(), downloads = new Map();
  const nonce = crypto.randomBytes(24).toString('hex');
  const prefix = `/segments/${nonce}`;
  const cacheRoot = path.resolve(__dirname, '../.local/segment-cache');
  const tracks = [];
  for (const name of ['video', 'audio']) {
    await control.wait();
    const descriptor = task[`${name}Track`];
    if (!descriptor) throw new Error('网页未提供轨道索引，请刷新新版脚本；本次分片试验未启动');
    const init = parseRange(descriptor.init), range = parseRange(descriptor.index), urls = sourceCandidates(task, name);
    let metadata, metadataError;
    onProgress({ stage: 'source', canPause: false });
    for (const url of urls) {
      try { metadata = await loadMetadata(url, init, range, fetcher, control, n => { received += n; }); break; }
      catch (error) { await control.wait(); metadataError = error; }
    }
    if (!metadata) throw new Error(`轨道初始化读取失败：${cleanError(metadataError || new Error('没有合法下载地址'))}`);
    const { buffer, initBuffer, url } = metadata;
    const index = parseSidx(buffer, range.offset);
    // SIDX presentation origin may include encoder delay (e.g. H264 B frames).
    const origin = index.segments[0].start;
    const selected = selectSegments(index, (task.cutMode === 'keyframe' && name === 'audio' ? tracks[0].cutStart : task.start) + origin, task.end + origin);
    // Cache identity includes the source init and index, not expiring signed URLs.
    const identity = crypto.createHash('sha256').update(JSON.stringify(['ranges-v2', task.id, task.cid, name, descriptor.codec])).update(buffer).update(initBuffer).digest('hex');
    const cache = path.join(cacheRoot, identity); await fs.mkdir(cache, { recursive: true });
    const items = [{ ...init, name: 'init', seed: initBuffer }, ...selected.map(s => ({ ...s, name: String(s.offset) }))];
    const track = { name, url, items, cache, selected, origin, cutStart: selected[0].start - origin, sourceEnd: index.end - origin, source: path.join(work, `${name}.mp4`), sources: [{ url, bytesPerSecond: 0 }], sourceIndex: 0, switches: 0, usedSources: new Set([url]) };
    tracks.push(track);
    for (const item of items) {
      item.file = path.join(cache, `${item.name}.bin`); item.done = false;
      try {
        const check = JSON.parse(await fs.readFile(item.file + '.json', 'utf8'));
        item.done = (await fs.stat(item.file)).size === item.size && check.sha256 === await hashFile(item.file);
      } catch {}
      if (item.seed && !item.done) {
        await fs.writeFile(item.file, item.seed); await fs.writeFile(item.file + '.json', JSON.stringify({ sha256: crypto.createHash('sha256').update(item.seed).digest('hex') })); item.done = true;
      }
      if (item.done) committed += item.size;
      else {
        try {
          const partial = item.file + '.partial';
          const saved = JSON.parse(await fs.readFile(partial + '.json', 'utf8'));
          const size = (await fs.stat(partial)).size;
          if (size > 0 && size < item.size && saved.bytes === size && saved.sha256 === await hashFile(partial)) item.partialBytes = size;
        } catch {}
      }
      delete item.seed;
    }
    const missing = items.find(item => item.name !== 'init' && !item.done);
    if (missing && urls.length > 1) {
      track.sources = await rankSources(urls, metadata, init, range, missing, fetcher, control, n => { received += n; });
      track.url = track.sources[0].url; track.usedSources = new Set([track.url]);
    }
  }
  const total = tracks.reduce((n, t) => n + t.items.reduce((s, i) => s + i.size, 0), 0);
  const preparedAt = performance.now(), mediaBytesAt = received;
  let samples = [{ at: preparedAt, bytes: received }], maxRequests = 0, zeroDataSeconds = 0;
  const update = () => {
    const now = performance.now(), last = samples[samples.length - 1];
    const elapsed = (now - last.at) / 1000;
    const instant = elapsed > 0 ? (received - last.bytes) / elapsed : 0;
    if (!control.paused && elapsed >= .5 && received === last.bytes && downloads.size) zeroDataSeconds += elapsed;
    maxRequests = Math.max(maxRequests, downloads.size);
    if (control.paused) samples = [{ at: now, bytes: received }];
    else if (elapsed >= .5) samples.push({ at: now, bytes: received });
    while (samples.length > 2 && samples[1].at <= now - 3000) samples.shift();
    const window = (now - samples[0].at) / 1000;
    const speed = control.paused || window <= 0 ? 0 : (received - samples[0].bytes) / window;
    const downloadedBytes = committed + [...inflight.values()].reduce((n, x) => n + x, 0) + tracks.reduce((sum, track) => sum + track.items.reduce((n, item) => n + (!item.done && !inflight.has(`${track.name}/${item.name}`) ? item.partialBytes || 0 : 0), 0), 0);
    onProgress({ stage: 'download', paused: control.paused, canPause: true, downloadedBytes, totalBytes: total, receivedBytes: received, bytesPerSecond: speed, instantaneousBytesPerSecond: control.paused ? 0 : instant, activeRequests: downloads.size, percent: Math.min(100, Math.floor(downloadedBytes / total * 100)), etaSeconds: speed > 0 ? Math.ceil((total - downloadedBytes) / speed) : null });
  };
  const ensure = async (track, item) => {
    if (item.done) return;
    const key = `${track.name}/${item.name}`;
    if (downloads.has(key)) return downloads.get(key);
    const promise = (async () => {
      await control.wait(); const c = control.controller();
      const partial = item.file + '.partial'; let handle, bytes = 0;
      const hash = crypto.createHash('sha256');
      try {
        const saved = JSON.parse(await fs.readFile(partial + '.json', 'utf8'));
        const size = (await fs.stat(partial)).size;
        if (size <= 0 || size >= item.size || saved.bytes !== size || saved.sha256 !== await hashFile(partial)) throw new Error('片内缓存校验失败');
        for await (const chunk of createReadStream(partial)) hash.update(chunk);
        bytes = size; item.partialBytes = bytes; inflight.set(key, bytes);
      } catch { await fs.rm(partial, { force: true }); await fs.rm(partial + '.json', { force: true }); }
      const timeout = setInterval(() => { if (performance.now() - activity > 60000) c.abort(new Error('分片连续 60 秒没有收到数据')); }, 1000);
      let activity = performance.now();
      const sourceIndex = track.sourceIndex, url = track.sources[sourceIndex].url, began = performance.now();
      try {
        const response = await rangedFetch(url, { offset: item.offset + bytes, size: item.size - bytes }, c.signal, fetcher);
        handle = await fs.open(partial, bytes ? 'a' : 'w');
        for await (const chunk of response.body) {
          received += chunk.length; activity = performance.now(); bytes += chunk.length;
          if (bytes > item.size) throw new Error('分片响应超出字节范围');
          hash.update(chunk); await handle.writeFile(chunk); item.partialBytes = bytes; inflight.set(key, bytes);
        }
        if (bytes !== item.size) throw new Error('分片响应不完整');
        await handle.close(); handle = null;
        await fs.rename(partial, item.file);
        await fs.writeFile(item.file + '.json', JSON.stringify({ sha256: hash.digest('hex') }));
        item.done = true; committed += bytes;
        // Switch future requests only; never discard progressing media for a slow sample.
        const seconds = (performance.now() - began) / 1000;
        const next = track.sources.findIndex(s => !track.usedSources.has(s.url) && s.bytesPerSecond > bytes / seconds * track.threads * 1.5);
        if (seconds >= 5 && next >= 0 && track.sourceIndex === sourceIndex) {
          track.sourceIndex = next; track.usedSources.add(track.sources[next].url); track.switches++;
        }
      } catch (error) {
        if (!control.paused && !control.cancelled && !c.signal.aborted) rememberSourceFailure(url, error);
        if (!control.paused && !control.cancelled && track.sources.length > 1 && track.sourceIndex === sourceIndex) {
          track.sourceIndex = (sourceIndex + 1) % track.sources.length;
          track.usedSources.add(track.sources[track.sourceIndex].url); track.switches++;
        }
        throw error;
      } finally {
        clearInterval(timeout); control.release(c); inflight.delete(key); await handle?.close();
        if (!item.done && bytes > 0 && bytes < item.size) {
          await fs.writeFile(partial + '.json', JSON.stringify({ bytes, sha256: hash.copy().digest('hex') }));
        } else {
          item.partialBytes = 0;
          await fs.rm(partial, { force: true }); await fs.rm(partial + '.json', { force: true });
        }
      }
    })();
    downloads.set(key, promise);
    maxRequests = Math.max(maxRequests, downloads.size);
    try { await promise; } finally { downloads.delete(key); }
  };
  const route = async (req, res) => {
    const itemPath = req.url.slice(prefix.length + 1), [name, id, extra] = itemPath.split('/');
    const track = tracks.find(t => t.name === name), item = track?.items.find(i => i.name === id);
    if (req.method !== 'GET' || !item || extra || req.headers.origin) { res.writeHead(403); res.end(); return; }
    try {
      await ensure(track, item);
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size, 'Cache-Control': 'no-store' });
      const stream = createReadStream(item.file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch (error) { if (!res.destroyed) { res.writeHead(502); res.end(cleanError(error)); } }
  };
  if (config.segmentNative === false) routes.set(prefix, route);
  control.canPause = true; update(); const timer = setInterval(update, 1000);
  try {
    const directTrack = async track => {
      const started = performance.now();
      const pending = track.items.filter(item => !item.done);
      let next = 0;
      const threads = downloadThreads(track.name, task.end - task.start, pending, config.segmentThreads);
      track.threads = threads;
      await Promise.allSettled(Array.from({ length: threads }, async () => {
        while (next < pending.length && !failure) {
          const item = pending[next++]; let failures = 0;
          while (!item.done && !failure) {
            try { await ensure(track, item); }
            catch (error) {
              if (control.cancelled) throw error;
              if (control.paused) { await control.wait(); continue; }
              if (++failures > 3) { failure ||= error; for (const c of control.controllers) c.abort(error); throw error; }
              await control.wait();
            }
          }
        }
      }));
      if (failure) throw failure;
      await control.wait();
      if (track.items.some(item => !item.done)) throw new Error('选区分片未全部完成');
      track.seconds = +((performance.now() - started) / 1000).toFixed(2);
    };
    const downloadTrack = async track => {
      const trackBegan = performance.now();
      // Audio uses one connection alongside the unchanged video pool (at most five by default).
      const threads = track.name === 'audio' && !config.segmentSerial ? 1 : (config.segmentThreads || 4);
      track.threads = threads;
      const playlist = path.join(work, `${track.name}.m3u8`);
      await fs.writeFile(playlist, makePlaylist(`http://127.0.0.1:${config.port || 18766}${prefix}/${track.name}`, track.selected));
      while (track.items.some(item => !item.done)) {
        await control.wait();
        if (failure) throw failure;
        const c = control.controller();
        try {
          // Preselected fragments: do not ask RE's SegmentBase parser to discover SIDX.
          await runner(config.segmentDownloader, [playlist, '--save-name', track.name, '--save-dir', work, '--tmp-dir', path.join(work, 'nre'), '--thread-count', String(threads), '--download-retry-count', '3', '--http-request-timeout', '90', '--use-system-proxy', 'false', '--auto-select', '--skip-merge', '--del-after-done', 'false', '--no-log', '--write-meta-json', 'false', '--disable-update-check', '--log-level', 'OFF', '--ffmpeg-binary-path', config.ffmpeg], { idleMs: 120000, signal: c.signal, activity: () => received });
          await Promise.allSettled([...downloads].filter(([key]) => key.startsWith(track.name + '/')).map(([, promise]) => promise));
          if (track.items.some(item => !item.done)) throw new Error('下载器结束，但选区分片未全部完成');
          break;
        } catch (error) {
          await Promise.allSettled([...downloads].filter(([key]) => key.startsWith(track.name + '/')).map(([, promise]) => promise));
          if (control.cancelled || !control.paused) throw error;
        } finally { control.release(c); }
      }
      track.seconds = +((performance.now() - trackBegan) / 1000).toFixed(2);
    };
    let failure;
    const guardedDownload = async track => {
      try { await (config.segmentNative === false ? downloadTrack(track) : directTrack(track)); }
      catch (error) {
        failure ||= error;
        for (const c of control.controllers) c.abort(error);
        throw error;
      }
    };
    if (config.segmentSerial) { for (const track of tracks) await guardedDownload(track); }
    else {
      await Promise.allSettled(tracks.map(guardedDownload));
      if (failure) throw failure;
    }
    const downloadedAt = performance.now();
    for (const track of tracks) {
      const output = await fs.open(track.source, 'w');
      try { for (const item of track.items) for await (const chunk of createReadStream(item.file)) await output.writeFile(chunk); }
      finally { await output.close(); }
    }
    await control.wait(); update();
    return { videoUrl: tracks[0].source, audioUrl: tracks[1].source, videoOrigin: tracks[0].origin, audioOrigin: tracks[1].origin, cutStart: task.cutMode === 'keyframe' ? tracks[0].cutStart : task.start, sourceEnd: Math.min(...tracks.map(t => t.sourceEnd)), downloadedBytes: total, receivedBytes: received, downloadSeconds: +((performance.now() - began) / 1000).toFixed(2), network: { engine: config.segmentNative === false ? 'nre' : 'native', prepareSeconds: +((preparedAt - began) / 1000).toFixed(2), transferSeconds: +((downloadedAt - preparedAt) / 1000).toFixed(2), assembleSeconds: +((performance.now() - downloadedAt) / 1000).toFixed(2), mediaReceivedBytes: received - mediaBytesAt, maxRequests, zeroDataSeconds: +zeroDataSeconds.toFixed(2) }, sources: tracks.map(t => ({ track: t.name, host: new URL(t.sources[t.sourceIndex].url).hostname, candidates: t.sources.length, switches: t.switches, threads: t.threads, seconds: t.seconds })) };
  } finally {
    clearInterval(timer); control.canPause = false; routes.delete(prefix);
    // Only process-owned generated files, never a user's note or attachment.
    await fs.rm(path.join(work, 'nre'), { recursive: true, force: true });
    for (const name of ['video.m3u8', 'audio.m3u8']) await fs.rm(path.join(work, name), { force: true });
  }
}
module.exports = { parseRange, parseSidx, selectSegments, makePlaylist, rangedFetch, downloadTracks, downloadThreads, TransferControl, cleanError, rankSources, loadMetadata, sourceCandidates };
