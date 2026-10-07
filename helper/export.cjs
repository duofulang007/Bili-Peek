const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { cleanError } = require('./segment-download.cjs');
const { needsRecognition, recognize } = require('./transcription.cjs');
const { resolveOutput } = require('./vault-paths.cjs');

function run(executable, args, timeout = 600000, onProgress) {
  return new Promise((resolve, reject) => {
    const options = typeof timeout === 'object' ? timeout : {};
    if (options.signal?.aborted) return reject(options.signal.reason);
    const child = spawn(executable, args, { windowsHide: true, shell: false, ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
    let output = '', progressBuffer = '', errors = '', failure, lastActivity = performance.now(), lastTime = -1, lastCounter = options.activity?.();
    const stop = error => {
      failure ||= error;
      if (options.killTree && process.platform === 'win32' && child.pid && child.exitCode === null) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const abort = () => stop(options.signal.reason || new Error('任务已取消'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = options.idleMs ? setInterval(() => {
      const counter = options.activity?.();
      if (counter !== lastCounter) { lastCounter = counter; lastActivity = performance.now(); }
      if (performance.now() - lastActivity > options.idleMs) stop(new Error(`连续 ${Math.round(options.idleMs / 1000)} 秒没有处理进展，请检查网络或重试`));
    }, 1000) : setTimeout(() => stop(new Error('处理超时')), typeof timeout === 'number' ? timeout : 600000);
    child.stdout.on('data', data => {
      output = (output + data).slice(-1000000);
      if (!onProgress) return;
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) {
          const seconds = Number(match[1]) / 1000000;
          if (seconds > lastTime) { lastTime = seconds; lastActivity = performance.now(); }
          onProgress(seconds);
        }
      }
    });
    // Drain stderr so a chatty failure cannot block the tool on a full pipe.
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); clearInterval(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', err => { cleanup(); reject(new Error(`无法启动处理工具：${err.code}`)); });
    child.on('close', code => { cleanup(); failure ? reject(failure) : code === 0 ? resolve(output) : reject(new Error(`媒体处理失败（${code}）：${cleanError(new Error(errors.trim() || '请检查媒体地址是否过期和工具配置'))}`)); });
  });
}

function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务参数无效');
  if (input.setDefaultDirectory !== undefined && typeof input.setDefaultDirectory !== 'boolean') throw new Error('默认保存路径选项无效');
  if (input.sourceHasSubtitles !== undefined && typeof input.sourceHasSubtitles !== 'boolean') throw new Error('源字幕状态无效');
  if (!/^(BV[0-9A-Za-z]{10}|av\d+)$/.test(input.id || '') || !Number.isSafeInteger(input.part) || input.part < 1 || !Number.isSafeInteger(input.cid) || input.cid <= 0) throw new Error('视频或分 P 标识无效');
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start) throw new Error('截取范围无效：开始时间须非负，结束时间须大于开始时间');
  if (input.cutMode !== undefined && (input.cutMode !== 'keyframe' || input.downloadEngine !== 'nre')) throw new Error('快速截取仅支持分片下载');
  if (input.downloadQuality !== undefined && (!Number.isInteger(input.downloadQuality) || input.downloadQuality <= 0 || input.downloadQuality > 1000)) throw new Error('下载画质无效');
  for (const name of ['videoUrl', 'audioUrl']) {
    const url = new URL(input[name]);
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)bilivideo\.(com|cn)$/.test(url.hostname) || (url.port && url.port !== '443')) throw new Error('媒体地址无效');
  }
  if (!Array.isArray(input.subtitles) || input.subtitles.length > 30000 || (!input.subtitles.length && input.videoOnly !== true)) throw new Error('当前视频没有可用字幕，请确认只保存视频后重试');
  if (input.subtitles.some(cue => !cue || !Number.isFinite(cue.from) || cue.from < 0 || !Number.isFinite(cue.to) || cue.to <= cue.from || typeof cue.content !== 'string' || cue.content.length > 10000)) throw new Error('字幕内容或时间格式无效');
  if (!Array.isArray(input.tags) || !input.tags.length || input.tags.length > 20 || input.tags.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) || /^\d+$/.test(tag) || tag.length > 100)) throw new Error('请填写至少一个有效标签后保存');
  if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 2000)) throw new Error('摘要最多 2000 字');
  return input;
}

function selectCues(cues, start, end) {
  return cues.filter(cue => Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.to > cue.from && typeof cue.content === 'string' && cue.to > start && cue.from < end)
    .sort((a, b) => a.from - b.from)
    .map(cue => ({ from: Math.max(cue.from, start) - start, to: Math.min(cue.to, end) - start, content: cue.content.slice(0, 10000), clipped: cue.from < start || cue.to > end }));
}
function stamp(seconds) {
  const whole = Math.floor(Math.round(seconds * 1000) / 1000);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].map(value => String(value).padStart(2, '0')).join(':');
}
function keyFor(task) { const identity = [task.id, task.part, task.cid, task.start, task.end]; if (task.cutMode) identity.push(task.cutMode); if (task.downloadQuality !== undefined) identity.push(['quality', task.downloadQuality]); return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20); }

function mediaCheck(probe, duration, sourceEnd, start = 0) {
  const streams = probe.streams || [], measured = Number(probe.format?.duration);
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const tolerance = 1;
  const missing = start + duration - sourceEnd;
  const atEnd = Number.isFinite(sourceEnd) && missing > 0 && missing <= tolerance && sourceEnd > start;
  const expected = atEnd ? sourceEnd - start : duration;
  const tracks = [video, audio];
  // Some containers omit stream durations. Validate available values without
  // requiring subsecond timestamps to accept an otherwise complete clip.
  const spansValid = tracks.every(stream => !Number.isFinite(Number(stream?.duration)) || (Number(stream.duration) > 0 && Math.abs(Number(stream.duration) - expected) <= tolerance));
  const starts = tracks.map(stream => Number(stream?.start_time));
  const startsValid = starts.every(time => !Number.isFinite(time) || Math.abs(time) <= tolerance)
    && (!starts.every(Number.isFinite) || Math.abs(starts[0] - starts[1]) <= tolerance);
  const valid = Boolean(video && audio && Number.isFinite(measured) && measured > 0 && Math.abs(measured - duration) <= tolerance && Math.abs(measured - expected) <= tolerance && spansValid && startsValid);
  return { valid, measured, expected, atEnd: valid && atEnd, tolerance };
}

function readingParagraphs(cues, withTimes = false) {
  const paragraphs = [];
  let text = '', began = 0, previous;
  for (const cue of cues) {
    const content = cue.content.trim();
    if (!content) continue;
    const sentenceEnd = /[。！？.!?][”’"'）)\]]*$/.test(text);
    const pause = previous && cue.from - previous.to >= 1.5;
    const longSentence = sentenceEnd && (text.length >= 180 || cue.from - began >= 35);
    if (text && (pause || longSentence || text.length >= 420)) { paragraphs.push({ text, began }); text = ''; }
    if (!text) began = cue.from;
    const separator = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(content) ? ' ' : '';
    text += separator + content;
    previous = cue;
  }
  if (text) paragraphs.push({ text, began });
  return paragraphs.map(({ text, began }) => {
    const time = stamp(Math.floor(began));
    return withTimes ? `**${began < 3600 ? time.slice(3) : time}**\n\n${text}` : text;
  }).join('\n\n');
}

function note(task, cues, key) {
  const tags = [...new Set(task.tags || [])];
  if (!cues.length) return `---\ntags: ${JSON.stringify(tags)}\ncreated: ${JSON.stringify(new Date().toISOString().slice(0, 10))}\nsource: ${JSON.stringify(`https://www.bilibili.com/video/${task.id}/?p=${task.part}&t=${task.start}`)}${task.summary?.trim() ? '\nsummary: ' + JSON.stringify(task.summary.trim()) : ''}\n---\n\n![[Bili-Peek附件/${key}.mp4]]\n\n> [!info] 未保存字幕\n> 此片段未取得可用字幕，仅保存视频。未生成转录文字。\n\n原视频区间：${stamp(task.start)}–${stamp(task.end)} · 第 ${task.part} P\n`;
  return `---\ntags: ${JSON.stringify(tags)}\ncreated: ${JSON.stringify(new Date().toISOString().slice(0, 10))}\nsource: ${JSON.stringify(`https://www.bilibili.com/video/${task.id}/?p=${task.part}&t=${task.start}`)}${task.summary?.trim() ? '\nsummary: ' + JSON.stringify(task.summary.trim()) : ''}\n---\n\n![[Bili-Peek附件/${key}.mp4]]\n\n## 片段字幕\n\n时间以片段起点为 00:00。${cues.some(cue => cue.clipped) ? '选区边界处保留字幕整句。' : ''}\n\n${readingParagraphs(cues, true)}\n`;
}

async function exportClip(task, config, runner = run, onProgress = () => {}, services = {}) {
  const began = performance.now(), timings = {};
  let stageBegan = began, currentStage;
  const stage = name => {
    const now = performance.now();
    if (currentStage) timings[currentStage] = +((now - stageBegan) / 1000).toFixed(2);
    currentStage = name; stageBegan = now;
    onProgress({ stage: name, elapsedSeconds: Math.floor((now - began) / 1000) });
  };
  stage('prepare');
  validateTask(task);
  if (config.videoEncoder !== undefined && !['libx264', 'h264_nvenc'].includes(config.videoEncoder)) throw new Error('视频编码配置无效');
  if (config.nvencQuality !== undefined && (!Number.isInteger(config.nvencQuality) || config.nvencQuality < 1 || config.nvencQuality > 51)) throw new Error('硬件编码质量配置无效');
  if (config.hardwareDecode !== undefined && typeof config.hardwareDecode !== 'boolean') throw new Error('硬件解码配置无效');
  let cues = selectCues(task.subtitles, task.start, task.end);
  if (!cues.length && task.videoOnly !== true) throw new Error('选区内没有字幕，请调整选区或确认只保存视频');
  const output = await resolveOutput(config, task.outputDirectory), key = keyFor(task);
  await fs.access(path.join(path.resolve(config.vault), '.obsidian'));
  const relative = path.relative(path.resolve(config.vault), output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('输出目录不在配置的仓库内');
  await fs.mkdir(output, { recursive: true });
  const attachments = path.join(output, 'Bili-Peek附件');
  await fs.mkdir(attachments, { recursive: true });
  // Resolve existing junctions before writing; confine all outputs to this vault.
  const actualVault = await fs.realpath(config.vault);
  for (const directory of [output, attachments]) {
    const rel = path.relative(actualVault, await fs.realpath(directory));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('输出目录链接指向仓库外');
  }
  const safeName = String(task.noteName || task.title || task.id).replace(/[<>:"/\\|?*\x00-\x1f\[\]#^]/g, ' ').trim().replace(/\.md$/i, '').replace(/[. ]+$/, '').slice(0, 80).trim() || '视频片段';
  const baseName = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i.test(safeName) ? '_' + safeName : safeName;
  let filename = baseName + '.md';
  try {
    const existing = await fs.readFile(path.join(output, filename), 'utf8');
    if (!existing.includes(`![[Bili-Peek附件/${key}.mp4]]`)) filename = `${baseName} - ${key.slice(0, 8)}.md`;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const notePath = path.join(output, filename), videoPath = path.join(attachments, `${key}.mp4`);
  const result = { notePath, filename, key, hasSubtitles: cues.length > 0, obsidianUri: `obsidian://open?path=${encodeURIComponent(notePath)}` };
  let duplicate = false;
  try { await Promise.all([fs.access(notePath), fs.access(videoPath)]); duplicate = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (duplicate) {
    const existing = await fs.readFile(notePath, 'utf8');
    if (/^(?:## 片段字幕|> \[!note\]- 片段字幕)\s*$/m.test(existing)) result.hasSubtitles = true;
    else if (needsRecognition(task) && config.buzz) {
      const sidecar = path.join(attachments, key + '.buzz.json');
      try {
        const saved = await fs.readFile(sidecar, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (saved) {
          if (saved.engine !== 'Buzz' || !Array.isArray(saved.cues)) throw new Error('已保存的 Buzz 识别稿格式无效，请保留文件并排错');
          result.recognition = { state: saved.cues.length ? 'complete' : 'empty', engine: 'Buzz', model: saved.model };
        } else {
          stage('transcribe');
          const info = JSON.parse(await runner(config.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', videoPath], 30000));
          const duration = Number(info.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('已保存视频的时长无效');
          const recognized = await (services.recognize || recognize)(videoPath, duration, config, runner);
          await services.checkpoint?.();
          await fs.writeFile(sidecar, JSON.stringify({ ...recognized, sourceHasSubtitles: false, duration, created: new Date().toISOString() }), { flag: 'wx' });
          result.recognition = { state: recognized.state, engine: 'Buzz', model: recognized.model };
        }
      } catch (error) {
        if (/任务已取消/.test(error.message)) throw error;
        result.recognition = { state: 'failed', engine: 'Buzz', error: cleanError(error) };
      }
    }
    return { ...result, duplicate: true };
  }
  const temp = await fs.mkdtemp(path.join(attachments, '.pending-'));
  try {
    const tempVideo = path.join(temp, 'clip.mp4'); let duration = task.end - task.start;
    const requestedStart = task.start;
    const mediaThreads = Math.max(2, Math.min(8, Math.ceil(require('node:os').availableParallelism() / 2)));
    const headers = 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n';
    let sources = task;
    if (task.downloadEngine === 'nre') {
      if (!services.download) throw new Error('分片下载试验尚未启用');
      stage('download');
      sources = await services.download(task, temp, update => onProgress({ ...update, elapsedSeconds: Math.floor((performance.now() - began) / 1000) }));
      result.download = { downloadedBytes: sources.downloadedBytes, receivedBytes: sources.receivedBytes, seconds: sources.downloadSeconds, sources: sources.sources, network: sources.network };
      if (task.cutMode === 'keyframe') {
        if (!Number.isFinite(sources.cutStart) || sources.cutStart < 0 || sources.cutStart > task.start) throw new Error('快速截取的关键帧起点无效');
        task = { ...task, start: sources.cutStart }; duration = task.end - task.start;
        cues = selectCues(task.subtitles, task.start, task.end); result.hasSubtitles = cues.length > 0;
        result.actualStart = task.start; result.requestedStart = requestedStart;
      }
    }
    const hardwareDecode = config.hardwareDecode === true && config.videoEncoder === 'h264_nvenc' && task.cutMode !== 'keyframe';
    const decodeArgs = hardwareDecode ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : [];
    const inputArgs = (url, origin = 0, video = false) => [...(video ? decodeArgs : []), ...(sources === task
      ? ['-threads', '2', '-protocol_whitelist', 'https,tls,tcp,crypto', '-rw_timeout', '30000000', '-headers', headers, '-ss', String(task.start), '-i', url]
      : ['-threads', '2', '-seek_timestamp', '1', '-ss', String(task.start + origin), '-i', url])];
    const progress = seconds => onProgress({ stage: currentStage, percent: Math.min(99, Math.max(0, Math.floor(seconds / duration * 100))), elapsedSeconds: Math.floor((performance.now() - began) / 1000) });
    stage('media');
    const videoEncoding = config.videoEncoder === 'h264_nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(config.nvencQuality ?? 27), '-b:v', '0', ...(hardwareDecode ? ['-vf', 'scale_cuda=format=yuv420p', '-pix_fmt', 'cuda'] : ['-pix_fmt', 'yuv420p']), '-bf', '3']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads:v', String(mediaThreads)];
    const encoding = task.cutMode === 'keyframe' ? ['-c:v', 'copy', '-c:a', 'copy'] : [...videoEncoding, '-c:a', 'aac', '-b:a', '160k', '-threads:a', '1'];
    result.videoEncoder = task.cutMode === 'keyframe' ? 'copy' : config.videoEncoder || 'libx264';
    result.hardwareDecode = hardwareDecode;
    await runner(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '2', '-progress', 'pipe:1', '-stats_period', '1', ...inputArgs(sources.videoUrl, sources.videoOrigin, true), ...inputArgs(sources.audioUrl, sources.audioOrigin), '-map', '0:v:0', '-map', '1:a:0', '-t', String(duration), ...encoding, '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', tempVideo], { idleMs: 120000 }, progress);
    stage('probe');
    const probe = JSON.parse(await runner(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', tempVideo], 30000));
    let check = mediaCheck(probe, duration);
    if (Number.isFinite(check.measured) && check.measured < duration - .5) {
      const sourceEnds = Number.isFinite(sources.sourceEnd) ? [sources.sourceEnd, sources.sourceEnd] : await Promise.all([task.videoUrl, task.audioUrl].map(async url => {
        try {
          const info = JSON.parse(await runner(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'https,tls,tcp,crypto', '-rw_timeout', '15000000', '-headers', headers, '-show_format', '-of', 'json', url], 20000));
          const end = Number(info.format?.duration); return Number.isFinite(end) && end > 0 ? end : NaN;
        } catch { return NaN; }
      }));
      if (sourceEnds.every(Number.isFinite)) check = mediaCheck(probe, duration, Math.min(...sourceEnds), task.start);
    }
    const measured = check.measured;
    if (!check.valid) throw new Error(`裁剪后音视频轨道或时长核验失败：所选 ${duration.toFixed(2)} 秒，实际 ${Number.isFinite(measured) ? measured.toFixed(2) : '未知'} 秒。请检查区间是否超过视频末尾`);
    if (check.atEnd) { cues = selectCues(task.subtitles, task.start, task.start + check.expected); result.hasSubtitles = cues.length > 0; }
    // Decode the result too; a readable container alone does not prove usable media.
    stage('verify');
    await runner(config.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', ...decodeArgs, '-threads', '2', '-filter_threads', '2', '-progress', 'pipe:1', '-stats_period', '1', '-i', tempVideo, '-threads', '2', '-f', 'null', '-'], { idleMs: 120000 }, progress);
    let recognition, recognitionText = '';
    if (needsRecognition(task) && config.buzz) {
      stage('transcribe');
      try {
        recognition = await (services.recognize || recognize)(tempVideo, measured, config, runner);
        result.recognition = { state: recognition.state, engine: recognition.engine, model: recognition.model };
        if (recognition.cues.length) {
          const text = `来源：Buzz · ${recognition.model}。自动语音识别结果，不属于原视频字幕；时间从片段起点计算。\n\n${readingParagraphs(recognition.cues, true)}`;
          recognitionText = '\n> [!note]- 语音识别稿\n' + text.split('\n').map(line => '> ' + line).join('\n') + '\n';
          await fs.writeFile(path.join(temp, 'asr.json'), JSON.stringify({ engine: recognition.engine, model: recognition.model, sourceHasSubtitles: false, duration: measured, created: new Date().toISOString(), cues: recognition.cues, srt: recognition.srt }), 'utf8');
        } else recognitionText = '\n> [!info] Buzz 未识别到可用语音，未生成识别稿。\n';
      } catch (error) {
        if (/任务已取消/.test(error.message)) throw error;
        result.recognition = { state: 'failed', engine: 'Buzz', error: cleanError(error) };
        recognition = undefined;
        recognitionText = `\n> [!warning] Buzz 语音识别未完成\n> ${cleanError(error).replace(/\n/g, '\n> ')}\n> 视频仍正常保存；未生成识别稿。\n`;
      }
    }
    stage('write');
    await services.checkpoint?.();
    const ending = check.atEnd ? `\n> 视频到达源文件末尾，实际保存时长 ${measured.toFixed(2)} 秒；页面标示时长与源文件略有差异。\n` : '';
    const fastInfo = task.cutMode === 'keyframe' ? `\n> 快速截取：请求起点 ${stamp(requestedStart)}，实际关键帧起点 ${stamp(task.start)}；字幕按实际起点计时。\n` : '';
    let content = note(task, cues, key);
    if (cues.length) content = content.replace(/## 片段字幕\n\n([\s\S]*)$/, (_, body) => '> [!note]- 片段字幕\n' + body.trimEnd().split('\n').map(line => '> ' + line).join('\n') + '\n');
    if (typeof task.sourceHasSubtitles === 'boolean') content = content.replace('\n---\n\n', `\nsource_has_subtitles: ${task.sourceHasSubtitles}\n---\n\n`);
    if (recognition?.cues.length) content = content.replace('未生成转录文字。', '语音识别稿另列下方，原视频没有字幕。');
    const noteContent = content + ending + fastInfo + recognitionText + '\n## 我的笔记\n\n';
    await services.backupNote?.(key, noteContent);
    await fs.writeFile(path.join(temp, 'note.md'), noteContent, 'utf8');
    // Exclusive commits never overwrite existing notes or attachments.
    const files = [['clip.mp4', videoPath], ['note.md', notePath], ...(recognition?.cues.length ? [['asr.json', path.join(attachments, key + '.buzz.json')]] : [])];
    for (const [source, target] of files) {
      try { await fs.link(path.join(temp, source), target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (source === 'note.md') {
          // Another concurrent video may have committed the same title since our initial check.
          const alternate = `${baseName} - ${key.slice(0, 8)}.md`;
          const alternatePath = path.join(output, alternate);
          await fs.link(path.join(temp, source), alternatePath);
          Object.assign(result, { filename: alternate, notePath: alternatePath, obsidianUri: `obsidian://open?path=${encodeURIComponent(alternatePath)}` });
        }
      }
    }
    for (const [filename] of files) await fs.unlink(path.join(temp, filename));
    for (const filename of ['video.mp4', 'audio.mp4', 'asr.json']) await fs.rm(path.join(temp, filename), { force: true });
    await fs.rmdir(temp);
    stage('complete');
    timings.total = +((performance.now() - began) / 1000).toFixed(2);
    return { ...result, duration: measured, timings };
  } catch (error) {
    try {
      for (const filename of ['clip.mp4', 'note.md', 'video.mp4', 'audio.mp4', 'asr.json']) await fs.unlink(path.join(temp, filename)).catch(err => { if (err.code !== 'ENOENT') throw err; });
      await fs.rmdir(temp);
    } catch { error.message += '；部分暂存文件未能清理'; }
    throw error;
  }
}
module.exports = { run, selectCues, stamp, validateTask, keyFor, note, exportClip, readingParagraphs, mediaCheck };
