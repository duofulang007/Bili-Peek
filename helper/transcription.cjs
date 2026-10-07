const fs = require('node:fs/promises');
const path = require('node:path');

function needsRecognition(task) {
  return task.sourceHasSubtitles === false && Array.isArray(task.subtitles) && task.subtitles.length === 0;
}

function parseSrt(text, duration) {
  if (text.length > 4000000) throw new Error('Buzz 识别稿过大');
  const time = value => { const [h, m, s, ms] = value.split(/[:,.]/).map(Number); if (m > 59 || s > 59) throw new Error('Buzz 识别稿时间无效'); return h * 3600 + m * 60 + s + ms / 1000; };
  const cues = [];
  for (const block of text.replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/), index = lines.findIndex(line => line.includes('-->'));
    const match = /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*$/.exec(lines[index] || '');
    if (!match) throw new Error('Buzz 识别稿时间格式无效');
    const from = time(match[1]), to = time(match[2]), content = lines.slice(index + 1).join('\n').trim();
    if (!Number.isFinite(from) || from < 0 || to <= from || to > duration + 1 || from >= duration || !content) throw new Error('Buzz 识别稿内容或时间超出片段范围');
    if (cues.length && from < cues[cues.length - 1].from) throw new Error('Buzz 识别稿时间顺序无效');
    cues.push({ from, to: Math.min(to, duration), content });
  }
  return cues;
}

async function recognizeOne(video, duration, config, runner) {
  if (!config.buzz || !path.isAbsolute(config.buzz)) throw new Error('Buzz 尚未配置，请安装并设置本地 Buzz 路径后重试');
  await fs.access(config.buzz);
  const model = config.buzzModel || 'small';
  if (!['tiny', 'base', 'small', 'medium', 'large'].includes(model)) throw new Error('Buzz 模型配置无效');
  const backend = config.buzzBackend || 'whisper';
  if (!['whisper', 'whispercpp'].includes(backend)) throw new Error('仅支持 Buzz 本地识别后端');
  const root = path.resolve(__dirname, '../.local/buzz-jobs');
  await fs.mkdir(root, { recursive: true });
  const work = await fs.mkdtemp(path.join(root, 'job-'));
  try {
    await runner(config.buzz, ['add', '--task', 'transcribe', '--model-type', backend, '--model-size', model, '--srt', '--hide-gui', '--output-directory', work, video], { idleMs: 3600000, killTree: true, env: { BUZZ_MODEL_ROOT: config.buzzModelRoot || path.resolve(__dirname, '../.local/buzz-models') } });
    const files = (await fs.readdir(work)).filter(name => name.endsWith('.srt'));
    if (files.length !== 1) throw new Error('Buzz 未生成唯一的字幕文件，未制造识别结果');
    const source = await fs.readFile(path.join(work, files[0]), 'utf8');
    const cues = parseSrt(source, duration);
    return { engine: 'Buzz', model: `${backend}/${model}`, state: cues.length ? 'complete' : 'empty', cues, srt: source };
  } finally { await fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
}

// ponytail: one Buzz model at a time; per-device queues if parallel ASR is needed.
let queue = Promise.resolve();
function recognize(video, duration, config, runner, signal) {
  let started = false;
  const task = queue.then(() => {
    started = true;
    if (signal?.aborted) throw signal.reason;
    return recognizeOne(video, duration, config, runner);
  });
  queue = task.catch(() => {});
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => { signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => { if (!started) settle(reject, signal.reason); };
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    task.then(value => settle(resolve, value), error => settle(reject, error));
  });
}

module.exports = { needsRecognition, parseSrt, recognize };
