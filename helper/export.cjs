const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function run(executable, args, timeout = 600000, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    let output = '', progressBuffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('处理超时')); }, timeout);
    child.stdout.on('data', data => {
      output = (output + data).slice(-1000000);
      if (!onProgress) return;
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress(Number(match[1]) / 1000000);
      }
    });
    // Drain stderr so a chatty failure cannot block the tool on a full pipe.
    child.stderr.resume();
    child.on('error', err => { clearTimeout(timer); reject(new Error(`无法启动处理工具：${err.code}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`媒体处理失败（${code}）。请检查媒体地址是否过期和工具配置。`)); });
  });
}

function validateTask(input) {
  if (!/^(BV[0-9A-Za-z]{10}|av\d+)$/.test(input.id || '') || !Number.isSafeInteger(input.part) || input.part < 1 || !Number.isSafeInteger(input.cid) || input.cid <= 0) throw new Error('视频或分 P 标识无效');
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start || input.end > 43200 || input.end - input.start > 1800) throw new Error('截取范围无效，单次最多 30 分钟');
  for (const name of ['videoUrl', 'audioUrl']) {
    const url = new URL(input[name]);
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)bilivideo\.(com|cn)$/.test(url.hostname) || (url.port && url.port !== '443')) throw new Error('媒体地址无效');
  }
  if (!Array.isArray(input.subtitles) || input.subtitles.length > 30000 || (!input.subtitles.length && input.videoOnly !== true)) throw new Error('当前视频没有可用字幕，请确认只保存视频后重试');
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
function keyFor(task) { return crypto.createHash('sha256').update(JSON.stringify([task.id, task.part, task.cid, task.start, task.end])).digest('hex').slice(0, 20); }

function mediaCheck(probe, duration, sourceEnd, start = 0) {
  const streams = probe.streams || [], measured = Number(probe.format?.duration);
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const [numerator, denominator] = String(video?.avg_frame_rate || '0/1').split('/').map(Number);
  const frame = denominator / numerator, tolerance = Math.max(.15, Number.isFinite(frame) ? frame * 2 : .15);
  const missing = start + duration - sourceEnd;
  const atEnd = Number.isFinite(sourceEnd) && missing > 0 && missing <= 1 + tolerance && sourceEnd > start;
  const expected = atEnd ? sourceEnd - start : duration;
  const valid = Boolean(video && audio && Number.isFinite(measured) && measured > 0 && Math.abs(measured - expected) <= tolerance);
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

async function exportClip(task, config, runner = run, onProgress = () => {}) {
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
  let cues = selectCues(task.subtitles, task.start, task.end);
  if (!cues.length && task.videoOnly !== true) throw new Error('选区内没有字幕，请调整选区或确认只保存视频');
  const output = path.resolve(config.output), key = keyFor(task);
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
  try {
    await Promise.all([fs.access(notePath), fs.access(videoPath)]);
    return { ...result, duplicate: true };
  } catch {}
  const temp = await fs.mkdtemp(path.join(attachments, '.pending-'));
  try {
    const tempVideo = path.join(temp, 'clip.mp4'), duration = task.end - task.start;
    const headers = 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n';
    const inputArgs = url => ['-protocol_whitelist', 'https,tls,tcp,crypto', '-rw_timeout', '30000000', '-headers', headers, '-ss', String(task.start), '-i', url];
    const progress = seconds => onProgress({ stage: currentStage, percent: Math.min(99, Math.max(0, Math.floor(seconds / duration * 100))), elapsedSeconds: Math.floor((performance.now() - began) / 1000) });
    stage('media');
    await runner(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-stats_period', '1', ...inputArgs(task.videoUrl), ...inputArgs(task.audioUrl), '-map', '0:v:0', '-map', '1:a:0', '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', tempVideo], 600000, progress);
    stage('probe');
    const probe = JSON.parse(await runner(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', tempVideo], 30000));
    let check = mediaCheck(probe, duration);
    if (!check.valid && Number.isFinite(check.measured) && check.measured < duration) {
      const sourceEnds = await Promise.all([task.videoUrl, task.audioUrl].map(async url => {
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
    await runner(config.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-progress', 'pipe:1', '-stats_period', '1', '-i', tempVideo, '-f', 'null', '-'], 300000, progress);
    stage('write');
    const ending = check.atEnd ? `\n> 视频到达源文件末尾，实际保存时长 ${measured.toFixed(2)} 秒；页面标示时长与源文件略有差异。\n` : '';
    await fs.writeFile(path.join(temp, 'note.md'), note(task, cues, key) + ending, 'utf8');
    // Exclusive commits never overwrite existing notes or attachments.
    const files = [['clip.mp4', videoPath], ['note.md', notePath]];
    for (const [source, target] of files) {
      try { await fs.link(path.join(temp, source), target); }
      catch (error) { if (error.code !== 'EEXIST' || source === 'note.md') throw error; }
    }
    for (const [filename] of files) await fs.unlink(path.join(temp, filename));
    await fs.rmdir(temp);
    stage('complete');
    timings.total = +((performance.now() - began) / 1000).toFixed(2);
    return { ...result, duration: measured, timings };
  } catch (error) {
    try {
      for (const filename of ['clip.mp4', 'note.md']) await fs.unlink(path.join(temp, filename)).catch(err => { if (err.code !== 'ENOENT') throw err; });
      await fs.rmdir(temp);
    } catch { error.message += '；部分暂存文件未能清理'; }
    throw error;
  }
}
module.exports = { run, selectCues, stamp, validateTask, keyFor, note, exportClip, readingParagraphs, mediaCheck };
