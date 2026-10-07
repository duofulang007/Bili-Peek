const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSidx, selectSegments, parseRange, makePlaylist } = require('../helper/segment-download.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
process.env.BILI_PEEK_SEGMENT_CACHE = path.resolve(__dirname, 'export-sandbox/segment-cache');
const http = require('node:http');
const { once } = require('node:events');
const { run, exportClip } = require('../helper/export.cjs');
const { downloadTracks, TransferControl, rangedFetch } = require('../helper/segment-download.cjs');
const { rankSources, loadMetadata, sourceCandidates } = require('../helper/segment-download.cjs');

test('automatic connection count grows with duration and uncached size and shrinks for cached tails', () => {
  const { downloadThreads } = require('../helper/segment-download.cjs');
  const pending = (count, mib, partial = 0) => Array.from({ length: count }, () => ({ size: mib * 1048576, partialBytes: partial * 1048576 }));
  assert.equal(downloadThreads('video', 20, pending(30, 1)), 4);
  assert.equal(downloadThreads('video', 60, pending(30, 2)), 8);
  assert.equal(downloadThreads('video', 300, pending(60, 2)), 12);
  assert.equal(downloadThreads('video', 300, pending(60, 9)), 16);
  assert.equal(downloadThreads('audio', 300, pending(60, .1)), 4);
  assert.equal(downloadThreads('video', 600, pending(2, 4, 3.9)), 1);
  assert.equal(downloadThreads('video', 300, pending(60, 9), 1000), 16);
  assert.equal(downloadThreads('video', 300, []), 0);
});

test('cold metadata transient timeout retries without requiring a second save click', async () => {
  let calls = 0;
  const bytes = Buffer.concat([Buffer.from('init'), index()]);
  const fetcher = async () => {
    if (++calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/99999` } });
  };
  const result = await loadMetadata('https://cold-test.bilivideo.com/v', { offset: 0, size: 4 }, { offset: 4, size: 68 }, fetcher, new TransferControl(), () => {});
  assert.deepEqual(result.buffer, index()); assert.equal(calls, 2);
});

test('exact clips prepare both tracks concurrently and stop siblings on metadata failure', async () => {
  await fs.mkdir(path.join(__dirname, 'export-sandbox'), { recursive: true });
  const folder = await fs.mkdtemp(path.join(__dirname, 'export-sandbox/prepare-'));
  const data = Buffer.concat([Buffer.from('init'), index(), Buffer.alloc(364, 7)]);
  const task = { id: 'BV1xx411c7mD', cid: Date.now(), start: 0, end: 4,
    videoUrl: 'https://prepare.bilivideo.com/video', audioUrl: 'https://prepare.bilivideo.com/audio',
    videoTrack: { init: '0-3', index: '4-71', codec: 'avc1' }, audioTrack: { init: '0-3', index: '4-71', codec: 'aac' } };
  let active = 0, peak = 0;
  const fetcher = async (url, options) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    if (+start === 0) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 40)); active--;
    }
    return new Response(data.subarray(+start, +end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}` } });
  };
  const result = await downloadTracks(task, {}, run, () => {}, new TransferControl(), new Map(), folder, fetcher);
  assert.equal(peak, 2, 'audio initialization must not wait for video initialization');
  assert.deepEqual(result.sources.map(source => source.track), ['video', 'audio']);
  const control = new TransferControl(); let siblingStopped = false, backupRequests = 0;
  await assert.rejects(downloadTracks({ ...task, cid: task.cid + 1, audioUrls: ['https://backup.bilivideo.com/audio'] }, {}, run, () => {}, control, new Map(), folder, async (url, options) => {
    if (url.endsWith('/video')) throw new Error('invalid metadata');
    if (url.includes('backup')) { backupRequests++; throw new Error('unexpected backup'); }
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { siblingStopped = true; reject(options.signal.reason); }, { once: true }));
  }), /invalid metadata/);
  assert.equal(siblingStopped, true);
  assert.equal(backupRequests, 0, 'a failed preparation must not start another source');
  assert.equal(control.controllers.size, 0);
});

test('fast cut with unequal audio and video fragment boundaries keeps duration and alignment', async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'tests/export-sandbox'), { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'tests/export-sandbox/unequal-'));
  await fs.mkdir(path.join(folder, '.obsidian'));
  const config = { vault: folder, output: path.join(folder, 'notes'), ffmpeg: path.join(root, '.tools/ffmpeg.exe'), ffprobe: path.join(root, '.tools/ffprobe.exe') };
  const sources = {}, descriptors = {};
  for (const name of ['video', 'audio']) {
    const file = path.join(folder, name + '.mp4');
    await run(config.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', name === 'video' ? 'testsrc2=size=320x180:rate=25' : 'sine=frequency=440:sample_rate=48000', '-t', '16', ...(name === 'video' ? ['-c:v', 'libx264', '-g', '100', '-bf', '8', '-b_strategy', '0'] : ['-c:a', 'aac']), '-movflags', 'dash+global_sidx', '-frag_duration', name === 'video' ? '4000000' : '6000000', file]);
    const bytes = sources[name] = await fs.readFile(file); let p = 0;
    while (bytes.toString('ascii', p + 4, p + 8) !== 'sidx') p += bytes.readUInt32BE(p);
    descriptors[name] = { init: `0-${p - 1}`, index: `${p}-${p + bytes.readUInt32BE(p) - 1}`, codec: name };
  }
  const fetcher = async (url, options) => {
    const data = sources[url.endsWith('/video') ? 'video' : 'audio'];
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    return new Response(data.subarray(+start, +end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}` } });
  };
  const task = { id: 'BV1xx411c7mD', part: 1, cid: Date.now(), start: 5.1, end: 9.4, downloadEngine: 'nre', cutMode: 'keyframe', videoUrl: 'https://unequal.bilivideo.com/video', audioUrl: 'https://unequal.bilivideo.com/audio', videoTrack: descriptors.video, audioTrack: descriptors.audio, subtitles: [], videoOnly: true, tags: ['测试'] };
  let result;
  for (const end of [9.4, 9.401, 9.419, 9.439, 9.459, 9.479, 9.499]) {
    result = await exportClip({ ...task, end }, config, run, () => {}, { download: (input, work, progress) => downloadTracks(input, config, run, progress, new TransferControl(), new Map(), work, fetcher) });
    assert.ok(Math.abs(result.duration - (end - result.actualStart)) < .15);
  }
  const file = path.join(config.output, 'Bili-Peek附件', result.key + '.mp4');
  const probe = JSON.parse(await run(config.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file]));
  assert.ok(Math.abs(+probe.streams.find(s => s.codec_type === 'video').start_time - +probe.streams.find(s => s.codec_type === 'audio').start_time) < .1);
});

test('source cooldown skips repeatedly unavailable hosts but retains a last available fallback', async () => {
  const bad = 'https://cooldown-test.bilivideo.com/v', good = 'https://healthy-test.bilivideo.com/v';
  const fetcher = async () => new Response('', { status: 503 });
  for (let i = 0; i < 2; i++) await assert.rejects(loadMetadata(bad, { offset: 0, size: 4 }, { offset: 4, size: 68 }, fetcher, new TransferControl(), () => {}), /HTTP 503/);
  assert.deepEqual(sourceCandidates({ videoUrl: bad, videoUrls: [good] }, 'video'), [good]);
  assert.deepEqual(sourceCandidates({ videoUrl: bad }, 'video'), [bad]);
  assert.equal(sourceCandidates({ videoUrl: 'https://cooldown-test.bilivideo.com/audio', videoUrls: [good] }, 'video').length, 2, 'a failed resource does not cool down other tracks on the same host');
});

test('native scheduling gives larger audio two workers and caps overall requests', async () => {
  const folder = await fs.mkdtemp(path.resolve(__dirname, 'export-sandbox/native-workers-'));
  const media = {}, descriptors = {}, current = { video: 0, audio: 0 }, peaks = { video: 0, audio: 0 };
  for (const name of ['video', 'audio']) {
    const sidx = index();
    if (name === 'audio') for (let p = 32; p < sidx.length; p += 12) sidx.writeUInt32BE(400000, p);
    const segments = parseSidx(sidx, 4).segments;
    media[name] = Buffer.concat([Buffer.from('init'), sidx, Buffer.alloc(4), ...segments.map(segment => Buffer.alloc(segment.size, 7))]);
    descriptors[name] = { init: '0-3', index: `4-${sidx.length + 3}`, codec: name };
  }
  const fetcher = async (url, options) => {
    const name = url.endsWith('/video') ? 'video' : 'audio';
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    current[name]++; peaks[name] = Math.max(peaks[name], current[name]);
    await new Promise(resolve => setTimeout(resolve, 30)); current[name]--;
    return new Response(media[name].subarray(+start, +end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${media[name].length}` } });
  };
  const task = { id: 'BV1xx411c7mD', cid: Date.now(), start: 0, end: 5, videoUrl: 'https://workers.bilivideo.com/video', audioUrl: 'https://workers.bilivideo.com/audio', videoTrack: descriptors.video, audioTrack: descriptors.audio };
  const stats = await downloadTracks(task, {}, () => { throw new Error('unexpected child process'); }, () => {}, new TransferControl(), new Map(), folder, fetcher);
  assert.equal(peaks.audio, 2); assert.ok(peaks.video <= 4 && stats.network.maxRequests <= 6);
  for (const name of ['video', 'audio']) assert.deepEqual(await fs.readFile(path.join(folder, name + '.mp4')), Buffer.concat([Buffer.from('init'), Buffer.alloc(name === 'audio' ? 1200000 : 360, 7)]));
});

test('long uncached clip uses sixteen real range workers and matches the four-worker output', async () => {
  const folder = await fs.mkdtemp(path.resolve(__dirname, 'export-sandbox/auto-workers-'));
  const count = 16, sidx = Buffer.alloc(32 + count * 12);
  sidx.writeUInt32BE(sidx.length, 0); sidx.write('sidx', 4); sidx.writeUInt32BE(1, 12); sidx.writeUInt32BE(1000, 16); sidx.writeUInt32BE(4, 24); sidx.writeUInt16BE(count, 30);
  for (let i = 0; i < count; i++) { const p = 32 + i * 12; sidx.writeUInt32BE(1048576, p); sidx.writeUInt32BE(37500, p + 4); sidx.writeUInt32BE(0x90000000, p + 8); }
  const video = Buffer.concat([Buffer.from('init'), sidx, Buffer.alloc(4), Buffer.alloc(count * 1048576, 7)]);
  const audioIndex = index(), audio = Buffer.concat([Buffer.from('init'), audioIndex, Buffer.alloc(4), Buffer.alloc(360, 7)]);
  const measurements = [];
  for (const config of [{ segmentThreads: 4 }, {}]) {
    const work = await fs.mkdtemp(path.join(folder, 'run-')); let active = 0, peak = 0;
    const fetcher = async (url, options) => {
      const data = url.endsWith('/video') ? video : audio;
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 90)); active--;
      return new Response(data.subarray(+start, +end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}` } });
    };
    const task = { id: 'BV1xx411c7mD', cid: Date.now() + measurements.length, start: 0, end: 600, videoUrl: 'https://auto-workers.bilivideo.com/video', audioUrl: 'https://auto-workers.bilivideo.com/audio', videoTrack: { init: '0-3', index: `4-${sidx.length + 3}`, codec: 'avc1' }, audioTrack: { init: '0-3', index: '4-71', codec: 'aac' } };
    const result = await downloadTracks(task, config, () => { throw Error('unexpected child'); }, () => {}, new TransferControl(), new Map(), work, fetcher);
    assert.deepEqual(await fs.readFile(path.join(work, 'video.mp4')), Buffer.concat([Buffer.from('init'), Buffer.alloc(count * 1048576, 7)]));
    measurements.push({ threads: result.sources[0].threads, peak, seconds: result.network.transferSeconds, bytes: result.network.mediaReceivedBytes });
  }
  assert.equal(measurements[0].threads, 4); assert.equal(measurements[1].threads, 16);
  assert.ok(measurements[1].peak >= 16 && measurements[1].peak <= 17);
  assert.equal(measurements[0].bytes, measurements[1].bytes);
  console.log('AUTO_WORKERS_CONTROLLED ' + JSON.stringify(measurements));
});

test('same-track source selection measures bounded bytes, prefers faster backup and rejects different init', async () => {
  const urls = ['https://slow.bilivideo.com/v', 'https://fast.bilivideo.com/v', 'https://wrong.bilivideo.com/v'];
  const metadata = { url: urls[0], buffer: index(), initBuffer: Buffer.from('init') };
  const calls = [], fetcher = async (url, options) => {
    calls.push({ url, range: options.headers.Range });
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const bytes = +end - +start + 1;
    await new Promise(resolve => setTimeout(resolve, url.includes('slow') ? 80 : 5));
    const initialization = Buffer.from(url.includes('wrong') ? 'nope' : 'init');
    const data = +start === 0 ? (bytes > 4 ? Buffer.concat([initialization, index()]) : initialization) : +start === 4 ? index() : Buffer.alloc(bytes, 7);
    return new Response(data, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/9999999` } });
  };
  const ranked = await rankSources(urls, metadata, { offset: 0, size: 4 }, { offset: 4, size: 68 }, { offset: 100, size: 2000000 }, fetcher, new TransferControl(), () => {});
  assert.equal(ranked[0].url, urls[1]);
  assert.deepEqual(new Set(ranked.map(x => x.url)), new Set(urls.slice(0, 2)));
  assert.ok(calls.filter(c => c.range.startsWith('bytes=100-')).every(c => c.range === 'bytes=100-1048675'), 'probe limited to 1 MiB');
});

test('source selection is cancellable and never hides cancellation as source failure', async () => {
  const control = new TransferControl(); control.cancel();
  await assert.rejects(rankSources(['https://a.bilivideo.com/v', 'https://b.bilivideo.com/v'], { url: 'https://a.bilivideo.com/v', buffer: Buffer.from('i'), initBuffer: Buffer.from('h') }, { offset: 0, size: 1 }, { offset: 1, size: 1 }, { offset: 2, size: 3 }, async () => { throw Error('must not fetch'); }, control, () => {}), /取消/);
  const pending = new TransferControl();
  const fetcher = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  const running = rankSources(['https://a.bilivideo.com/v', 'https://b.bilivideo.com/v'], { url: 'https://a.bilivideo.com/v', buffer: Buffer.from('i'), initBuffer: Buffer.from('h') }, { offset: 0, size: 1 }, { offset: 1, size: 1 }, { offset: 2, size: 3 }, fetcher, pending, () => {});
  setTimeout(() => pending.cancel(), 10);
  await assert.rejects(running, /取消/);
});

function index(version = 0) {
  const b = Buffer.alloc(version ? 76 : 68);
  b.writeUInt32BE(b.length, 0); b.write('sidx', 4); b[8] = version;
  b.writeUInt32BE(1, 12); b.writeUInt32BE(1000, 16);
  let p = 20;
  if (version) { b.writeBigUInt64BE(0n, p); b.writeBigUInt64BE(4n, p + 8); p += 16; }
  else { b.writeUInt32BE(0, p); b.writeUInt32BE(4, p + 4); p += 8; }
  b.writeUInt16BE(3, p + 2); p += 4;
  for (const [size, duration] of [[100, 2000], [120, 2000], [140, 1000]]) {
    b.writeUInt32BE(size, p); b.writeUInt32BE(duration, p + 4); b.writeUInt32BE(0x90000000, p + 8); p += 12;
  }
  return b;
}
test('SIDX v0/v1 resolve absolute byte offsets, variable duration and SAP boundaries', () => {
  for (const version of [0, 1]) {
    const b = index(version), parsed = parseSidx(b, 900);
    assert.equal(parsed.segments[0].offset, 900 + b.length + 4);
    assert.equal(parsed.segments[2].start, 4);
    assert.equal(parsed.end, 5);
    assert.deepEqual(selectSegments(parsed, 2.1, 4.5).map(s => s.start), [2, 4]);
    const playlist = makePlaylist('http://127.0.0.1:18766/segments/test/video', selectSegments(parsed, 2.1, 4.5));
    assert.match(playlist, /#EXTINF:2,/); assert.match(playlist, /#EXTINF:1,/);
  }
});
test('bad ranges, nested SIDX and truncated indexes fail closed', () => {
  for (const range of ['0-999999999', '-1-2', '3-2', '0-0\r\nHost:x']) assert.throws(() => parseRange(range));
  assert.deepEqual(parseRange('0-999'), { offset: 0, size: 1000 });
  assert.throws(() => parseSidx(index().subarray(0, 40), 0));
  const b = index(); b.writeUInt32BE(0x80000064, 32);
  assert.throws(() => parseSidx(b, 0), /嵌套/);
  const noSAP = index(); noSAP.writeUInt32BE(0, 52);
  assert.equal(selectSegments(parseSidx(noSAP, 0), 2.1, 3).at(0).start, 0);
  assert.throws(() => selectSegments(parseSidx(index(), 0), 6, 7));
});

test('range bridge rejects full-file responses and arbitrary hosts', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(Buffer.alloc(10), { status: 200 }); };
  await assert.rejects(rangedFetch('https://test.bilivideo.com/v', { offset: 10, size: 10 }, undefined, fetcher), /HTTP 200/);
  await assert.rejects(rangedFetch('https://127.0.0.1/private', { offset: 0, size: 10 }, undefined, fetcher), /地址无效/);
  assert.equal(calls, 1);
});

test('real NRE downloads selected media, pauses, reuses verified cache and produces the same off-keyframe clip', { skip: !require('node:fs').existsSync(path.resolve(__dirname, '../.tools/N_m3u8DL-RE.exe')) }, async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'tests/export-sandbox'), { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'tests/export-sandbox/segment-'));
  const ffmpeg = path.join(root, '.tools/ffmpeg.exe'), ffprobe = path.join(root, '.tools/ffprobe.exe');
  const segmentDownloader = path.join(root, '.tools/N_m3u8DL-RE.exe');
  const sources = {}, descriptors = {};
  for (const name of ['video', 'audio']) {
    const file = path.join(folder, `${name}.mp4`);
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', name === 'video' ? 'testsrc2=size=320x180:rate=25' : 'sine=frequency=440:sample_rate=48000', '-t', '12', ...(name === 'video' ? ['-c:v', 'libx264', '-g', '50'] : ['-c:a', 'aac']), '-movflags', 'dash+global_sidx', '-frag_duration', '2000000', file]);
    sources[name] = await fs.readFile(file);
    let p = 0;
    while (sources[name].toString('ascii', p + 4, p + 8) !== 'sidx') { const size = sources[name].readUInt32BE(p); assert.ok(size > 0); p += size; }
    const size = sources[name].readUInt32BE(p);
    descriptors[name] = { init: `0-${p - 1}`, index: `${p}-${p + size - 1}`, codec: name === 'video' ? 'avc1' : 'mp4a' };
  }
  const ranges = [], routes = new Map();
  const cacheRoot = process.env.BILI_PEEK_SEGMENT_CACHE; await fs.mkdir(cacheRoot, { recursive: true });
  const previousCache = new Set(await fs.readdir(cacheRoot));
  const fetcher = async (url, options) => {
    const name = url.includes('/video') ? 'video' : 'audio';
    const [, begin, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range), bytes = sources[name].subarray(+begin, +end + 1);
    ranges.push([name, +begin, +end]);
    const body = new ReadableStream({ async start(controller) {
      try {
        for (let i = 0; i < bytes.length; i += 4096) {
          if (options.signal.aborted) throw options.signal.reason;
          controller.enqueue(bytes.subarray(i, i + 4096)); await new Promise(resolve => setTimeout(resolve, 120));
        }
        controller.close();
      } catch (error) { controller.error(error); }
    } });
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${begin}-${end}/${sources[name].length}` } });
  };
  const server = http.createServer((req, res) => {
    for (const [prefix, handler] of routes) if (req.url.startsWith(prefix + '/')) return handler(req, res);
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { vault: folder, output: path.join(folder, 'notes'), ffmpeg, ffprobe, segmentDownloader, port: server.address().port, segmentNative: false, ...(process.env.BILI_PEEK_TEST_NVENC === 'full' ? { videoEncoder: 'h264_nvenc', hardwareDecode: true } : {}) };
  await fs.mkdir(path.join(folder, '.obsidian'));
  const task = { id: 'BV1xx411c7mD', part: 1, cid: Math.floor(Date.now() / 1000), start: 5.1, end: 7.4, videoUrl: 'https://test.bilivideo.com/video', audioUrl: 'https://test.bilivideo.com/audio', videoTrack: descriptors.video, audioTrack: descriptors.audio, subtitles: [], videoOnly: true, tags: ['测试'], noteName: '分片测试' };
  const control = new TransferControl(), updates = [], transfers = []; let didPause = false;
  const trackedRunner = async (exe, args, options) => {
    const transfer = { name: args[args.indexOf('--save-name') + 1], start: performance.now() };
    if (exe === segmentDownloader) transfers.push(transfer);
    try { return await run(exe, args, options); } finally { transfer.end = performance.now(); }
  };
  const began = performance.now();
  try {
    const result = await exportClip({ ...task, downloadEngine: 'nre' }, config, run, update => updates.push(update), {
      download: (task, work, progress) => downloadTracks(task, config, trackedRunner, update => {
        progress(update);
        if (!didPause && update.receivedBytes > 20000 && update.downloadedBytes < update.totalBytes) {
          didPause = true; control.pause();
          setTimeout(() => control.resume(), 1500);
        }
      }, control, routes, work, fetcher)
    });
    assert.ok(didPause, 'exercise pause while data is in flight');
    assert.ok(transfers.find(t => t.name === 'audio').start < Math.max(...transfers.filter(t => t.name === 'video').map(t => t.end)), 'audio overlaps video instead of waiting for the video tail');
    assert.ok(result.download.network.maxRequests <= 5);
    assert.equal(result.download.sources.find(t => t.track === 'audio').threads, 1);
    assert.ok(updates.some(u => u.paused && u.bytesPerSecond === 0));
    assert.ok(updates.some(u => u.bytesPerSecond > 0));
    assert.ok(Math.abs(result.duration - 2.3) < .15, `duration ${result.duration}`);
    assert.ok(result.download.downloadedBytes < sources.video.length + sources.audio.length);
    const media = path.join(config.output, 'Bili-Peek附件', `${result.key}.mp4`);
    const localRunner = (exe, args, timeout, progress) => {
      const out = [];
      for (let i = 0; i < args.length; i++) {
        if (['-protocol_whitelist', '-headers', '-rw_timeout'].includes(args[i])) { i++; continue; }
        out.push(args[i] === task.videoUrl ? path.join(folder, 'video.mp4') : args[i] === task.audioUrl ? path.join(folder, 'audio.mp4') : args[i]);
      }
      return run(exe, out, timeout, progress);
    };
    const baseline = await exportClip(task, { ...config, output: path.join(folder, 'baseline') }, localRunner);
    const hashArgs = file => ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'framemd5', '-'];
    const actualHash = await run(ffmpeg, hashArgs(media));
    const expectedHash = await run(ffmpeg, hashArgs(path.join(folder, 'baseline/Bili-Peek附件', `${baseline.key}.mp4`)));
    assert.equal(actualHash.split('\n').filter(l => !l.startsWith('#')).join('\n'), expectedHash.split('\n').filter(l => !l.startsWith('#')).join('\n'), 'first decoded frame matches baseline cut');
    const audioFiles = [];
    for (const [name, file] of [['actual', media], ['baseline', path.join(folder, 'baseline/Bili-Peek附件', `${baseline.key}.mp4`)]]) {
      const pcm = path.join(folder, name + '.pcm');
      await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-t', '1', '-f', 's16le', pcm]); audioFiles.push(await fs.readFile(pcm));
    }
    assert.deepEqual(audioFiles[0], audioFiles[1], 'decoded first second of audio matches baseline');
    const secondWork = path.join(folder, 'reuse'); await fs.mkdir(secondWork);
    const previous = ranges.length;
    await downloadTracks(task, config, run, () => {}, new TransferControl(), routes, secondWork, fetcher);
    assert.equal(ranges.length - previous, 2, 'cached retry only refetches two combined indexes/init, no media');
    const newCache = (await fs.readdir(cacheRoot)).filter(name => !previousCache.has(name));
    assert.equal(newCache.length, 2);
    const corruptName = (await fs.readdir(path.join(cacheRoot, newCache[0]))).find(name => name.endsWith('.bin') && name !== 'init.bin');
    const corrupt = path.join(cacheRoot, newCache[0], corruptName), data = await fs.readFile(corrupt); data[data.length - 1] ^= 1; await fs.writeFile(corrupt, data);
    const thirdWork = path.join(folder, 'corruption'); await fs.mkdir(thirdWork);
    const beforeRepair = ranges.length;
    await downloadTracks(task, config, run, () => {}, new TransferControl(), routes, thirdWork, fetcher);
    assert.equal(ranges.length - beforeRepair, 3, 'same-size corruption refetches exactly one fragment in addition to metadata');
    const nativeWork = path.join(folder, 'native'); await fs.mkdir(nativeWork);
    const nativeTask = { ...task, cid: task.cid + 1000 };
    const nativeConfig = { ...config, segmentNative: true };
    const nativeControl = new TransferControl(); let nativePaused = false;
    const nativeBefore = ranges.length;
    const nativeStats = await downloadTracks(nativeTask, nativeConfig, () => { throw new Error('native download must not spawn external tools'); }, update => {
      if (!nativePaused && update.receivedBytes > 20000 && update.downloadedBytes < update.totalBytes) {
        nativePaused = true; nativeControl.pause(); setTimeout(() => nativeControl.resume(), 1200);
      }
    }, nativeControl, routes, nativeWork, fetcher);
    assert.ok(nativePaused);
    assert.equal(nativeStats.network.engine, 'native');
    assert.ok(nativeStats.network.maxRequests <= 6);
    assert.equal(routes.size, 0, 'native path needs no HTTP bridge');
    for (const name of ['video', 'audio']) assert.deepEqual(await fs.readFile(path.join(nativeWork, name + '.mp4')), await fs.readFile(path.join(thirdWork, name + '.mp4')));
    const originalOffsets = new Set(['video', 'audio'].flatMap(name => {
      const range = parseRange(descriptors[name].index);
      return parseSidx(sources[name].subarray(range.offset, range.offset + range.size), range.offset).segments.map(s => `${name}/${s.offset}`);
    }));
    assert.ok(ranges.slice(nativeBefore).some(([name, start]) => start > +descriptors[name].index.split('-')[1] && !originalOffsets.has(`${name}/${start}`)), 'pause resumes inside a media fragment instead of downloading its prefix again');
    const overlapWork = path.join(folder, 'overlap'); await fs.mkdir(overlapWork);
    const beforeOverlap = ranges.length;
    await downloadTracks({ ...nativeTask, start: 6.1, end: 7.2 }, nativeConfig, run, () => {}, new TransferControl(), routes, overlapWork, fetcher);
    assert.equal(ranges.length - beforeOverlap, 2, 'overlapping intervals reuse the same verified source fragments');
    for (const name of ['video', 'audio']) {
      const descriptor = descriptors[name], range = parseRange(descriptor.index), initialization = parseRange(descriptor.init);
      const parsed = parseSidx(sources[name].subarray(range.offset, range.offset + range.size), range.offset);
      const selection = selectSegments(parsed, 6.1 + parsed.segments[0].start, 7.2 + parsed.segments[0].start);
      assert.deepEqual(await fs.readFile(path.join(overlapWork, name + '.mp4')), Buffer.concat([sources[name].subarray(initialization.offset, initialization.offset + initialization.size), ...selection.map(segment => sources[name].subarray(segment.offset, segment.offset + segment.size))]));
    }
    const fastTask = { ...nativeTask, cutMode: 'keyframe', downloadEngine: 'nre', noteName: '快速截取测试' };
    const fastResult = await exportClip(fastTask, nativeConfig, run, () => {}, { download: (input, work, progress) => downloadTracks(input, nativeConfig, run, progress, new TransferControl(), routes, work, fetcher) });
    assert.ok(fastResult.actualStart < task.start && fastResult.actualStart >= 0);
    assert.ok(Math.abs(fastResult.duration - (task.end - fastResult.actualStart)) < .2);
    assert.notEqual(fastResult.key, result.key, 'fast mode never reuses an exact-mode export');
    assert.match(await fs.readFile(fastResult.notePath, 'utf8'), /实际关键帧起点/);
    const fastMedia = path.join(config.output, 'Bili-Peek附件', `${fastResult.key}.mp4`);
    const frameDigest = output => output.split('\n').filter(line => line && !line.startsWith('#'))[0].split(',').pop().trim();
    const fastFrame = await run(ffmpeg, hashArgs(fastMedia));
    const originalFrame = await run(ffmpeg, ['-v', 'error', '-ss', String(fastResult.actualStart), '-i', path.join(folder, 'video.mp4'), '-map', '0:v:0', '-frames:v', '1', '-f', 'framemd5', '-']);
    assert.equal(frameDigest(fastFrame), frameDigest(originalFrame), 'fast first decoded frame is identical to the source keyframe');
    const fastProbe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', fastMedia]));
    assert.ok(Math.abs(+fastProbe.streams.find(s => s.codec_type === 'video').start_time - +fastProbe.streams.find(s => s.codec_type === 'audio').start_time) < .08, 'fast mode retains audio/video start alignment');
    const nativeFailureWork = path.join(folder, 'native-failure'); await fs.mkdir(nativeFailureWork);
    const nativeFailureControl = new TransferControl();
    const nativeFailureFetcher = (url, options) => {
      const start = +/^bytes=(\d+)/.exec(options.headers.Range)[1];
      return url.includes('/audio') && start > +descriptors.audio.index.split('-')[1] ? Promise.resolve(new Response('', { status: 503 })) : fetcher(url, options);
    };
    await assert.rejects(downloadTracks({ ...nativeTask, cid: task.cid + 1900 }, nativeConfig, run, () => {}, nativeFailureControl, routes, nativeFailureWork, nativeFailureFetcher), /HTTP 503/);
    assert.equal(nativeFailureControl.controllers.size, 0, 'native failure waits for sibling requests before releasing task');
    const failoverWork = path.join(folder, 'failover'); await fs.mkdir(failoverWork);
    let failBackup = false;
    const failoverFetcher = async (url, options) => {
      if (!url.includes('backup')) return fetcher(url, options);
      if (failBackup) return new Response('', { status: 503 });
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      return new Response(sources.video.subarray(+start, +end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${sources.video.length}` } });
    };
    const failoverRunner = (exe, args, options) => { if (exe === segmentDownloader) failBackup = true; return run(exe, args, options); };
    const switched = await downloadTracks({ ...task, cid: task.cid + 500, videoUrls: [task.videoUrl, 'https://backup.bilivideo.com/video'] }, config, failoverRunner, () => {}, new TransferControl(), routes, failoverWork, failoverFetcher);
    assert.equal(switched.sources[0].candidates, 2);
    assert.ok(switched.sources[0].switches >= 1, 'selected fast backup fails and switches on actual RE retry');
    assert.equal(switched.sources[0].host, 'test.bilivideo.com');
    assert.deepEqual(await fs.readFile(path.join(failoverWork, 'video.mp4')), await fs.readFile(path.join(thirdWork, 'video.mp4')), 'fallback preserves exact selected media');
    const slowWork = path.join(folder, 'slow-switch'); await fs.mkdir(slowWork);
    let slowMode = false, servedBackup = false;
    const slowFetcher = async (url, options) => {
      const name = url.includes('/video') ? 'video' : 'audio';
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const data = sources[name].subarray(+start, +end + 1);
      const backup = url.includes('backup');
      if (slowMode && name === 'video' && data.length > 2000) {
        if (backup) servedBackup = true;
        else await new Promise(resolve => setTimeout(resolve, 5100));
      }
      if (backup) await new Promise(resolve => setTimeout(resolve, 50));
      return new Response(data, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${sources[name].length}` } });
    };
    const slowRunner = (exe, args, options) => { if (exe === segmentDownloader) slowMode = true; return run(exe, args, options); };
    const slowResult = await downloadTracks({ ...task, cid: task.cid + 700, videoUrls: [task.videoUrl, 'https://slow-backup.bilivideo.com/video'] }, { ...config, segmentThreads: 1 }, slowRunner, () => {}, new TransferControl(), routes, slowWork, slowFetcher);
    assert.ok(servedBackup && slowResult.sources[0].switches >= 1, 'completed slow fragment moves future requests to faster measured backup');
    assert.deepEqual(await fs.readFile(path.join(slowWork, 'video.mp4')), await fs.readFile(path.join(thirdWork, 'video.mp4')), 'slow-source switch preserves all media bytes');
    const failureWork = path.join(folder, 'parallel-failure'); await fs.mkdir(failureWork);
    let videoStopped = false, videoStarted;
    const started = new Promise(resolve => { videoStarted = resolve; });
    const failureRunner = async (exe, args, options) => {
      if (args[args.indexOf('--save-name') + 1] === 'audio') { await started; throw new Error('音频测试失败'); }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { videoStopped = true; reject(options.signal.reason); }, { once: true });
        videoStarted();
      });
    };
    await assert.rejects(downloadTracks({ ...task, cid: task.cid + 900 }, config, failureRunner, () => {}, new TransferControl(), routes, failureWork, fetcher), /音频测试失败/);
    assert.ok(videoStopped, 'failure aborts sibling track before cleaning up routes');
    assert.equal(routes.size, 0);
    const manager = require('../helper/segment-cache.cjs').cacheManager(config);
    const budgetPin = await manager.acquire('e'.repeat(64), manager.limit, folder);
    const boundedWork = path.join(folder, 'bounded'); await fs.mkdir(boundedWork);
    try {
      await downloadTracks(nativeTask, nativeConfig, run, () => {}, new TransferControl(), routes, boundedWork, fetcher);
      for (const name of ['video', 'audio']) assert.deepEqual(await fs.readFile(path.join(boundedWork, name + '.mp4')), await fs.readFile(path.join(thirdWork, name + '.mp4')), 'temporary storage preserves assembled media when active cache occupies the budget');
      await assert.rejects(fs.access(path.join(boundedWork, 'segment-transient')), { code: 'ENOENT' });
      assert.ok((await manager.status()).bytes <= manager.limit);
      assert.equal(manager.pins.size, 1, 'only the test reservation remains after download cleanup');
    } finally { await budgetPin.release(); }
    const benchmark = [];
    if (process.env.BILI_PEEK_SEGMENT_BENCHMARK === '1') for (let sample = 0; sample < 2; sample++) for (const serial of sample ? [false, true] : [true, false]) {
      const benchWork = path.join(folder, `benchmark-${sample}-${serial}`); await fs.mkdir(benchWork);
      const benchTask = { ...task, cid: task.cid + 100 + sample * 10 + Number(serial) };
      const began = performance.now();
      const stats = await downloadTracks(benchTask, { ...config, segmentNative: serial ? false : true }, run, () => {}, new TransferControl(), routes, benchWork, fetcher);
      assert.deepEqual(await fs.readFile(path.join(benchWork, 'video.mp4')), await fs.readFile(path.join(thirdWork, 'video.mp4')));
      assert.deepEqual(await fs.readFile(path.join(benchWork, 'audio.mp4')), await fs.readFile(path.join(thirdWork, 'audio.mp4')));
      benchmark.push({ sample, mode: serial ? 'nre-parallel' : 'native-parallel', seconds: +((performance.now() - began) / 1000).toFixed(3), bytes: stats.receivedBytes, network: stats.network });
    }
    await fs.writeFile(path.join(root, '.local/segment-prototype-test.json'), JSON.stringify({ fixture: 'synthetic 12-second fragmented source, 5.1–7.4 second off-keyframe cut; not Bilibili; per-request delay 120ms per 4096 bytes', duration: result.duration, bytes: result.download, sourceBytes: sources.video.length + sources.audio.length, baselineSeconds: baseline.timings.total, prototypeSeconds: result.timings.total, elapsedSeconds: (performance.now() - began) / 1000, pauseAndCacheReuse: true, corruptCacheRepaired: true, firstFrameMatches: true, decodedAudioMatches: true, benchmark }, null, 2));
  } finally { control.cancel(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('idle watchdog allows continuing progress, terminates stalled work and supports cancellation', async () => {
  const updates = [];
  await run(process.execPath, ['-e', 'let t=0;const i=setInterval(()=>{console.log("out_time_us="+(++t*100000));if(t===8)clearInterval(i)},300)'], { idleMs: 500 }, seconds => updates.push(seconds));
  assert.equal(updates.length, 8, 'work may exceed idle limit while progress advances');
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { idleMs: 100 }), /没有处理进展/);
  const control = new TransferControl(), c = control.controller();
  const promise = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { idleMs: 5000, signal: c.signal });
  setTimeout(() => control.cancel(), 100);
  await assert.rejects(promise, /取消/);
  await assert.rejects(control.wait(), /取消/);
});
