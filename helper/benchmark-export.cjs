const fs = require('node:fs/promises');
const path = require('node:path');
const { run, exportClip } = require('./export.cjs');
(async () => {
  const root = path.resolve(__dirname, '..');
  const folder = await fs.mkdtemp(path.join(root, '.local/benchmark-'));
  const ffmpeg = path.join(root, '.tools/ffmpeg.exe');
  const ffprobe = path.join(root, '.tools/ffprobe.exe');
  const source = path.join(folder, 'source.mp4');
  await fs.mkdir(path.join(folder, '.obsidian'));
  await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '36', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '8', '-c:a', 'aac', source]);
  const task = { id: 'BV1xx411c7mD', part: 1, cid: 1, start: 5.1, end: 35.1, videoUrl: 'https://benchmark.bilivideo.com/video', audioUrl: 'https://benchmark.bilivideo.com/audio', subtitles: [], videoOnly: true, tags: ['测试'] };
  const localRunner = (executable, args, timeout, progress) => {
    const local = [];
    for (let i = 0; i < args.length; i++) {
      if (['-protocol_whitelist', '-rw_timeout', '-headers'].includes(args[i])) { i++; continue; }
      local.push(args[i].startsWith('https://benchmark.bilivideo.com/') ? source : args[i]);
    }
    return run(executable, local, timeout, progress);
  };
  const results = [];
  for (const [videoEncoder, hardwareDecode] of [['libx264', false], ['h264_nvenc', false], ['h264_nvenc', true], ['h264_nvenc', true], ['h264_nvenc', false], ['libx264', false]]) {
    const output = path.join(folder, String(results.length));
    const result = await exportClip(task, { vault: folder, output, ffmpeg, ffprobe, videoEncoder, hardwareDecode, nvencQuality: Number(process.argv[2] || 27) }, localRunner);
    const file = path.join(output, 'Bili-Peek附件', result.key + '.mp4');
    const stats = path.relative(root, path.join(folder, `ssim-${results.length}.txt`)).replaceAll('\\', '/');
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-threads', '2', '-ss', String(task.start), '-i', source, '-threads', '2', '-i', file, '-filter_complex_threads', '2', '-lavfi', `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=${stats}`, '-an', '-t', '30', '-f', 'null', '-']);
    const scores = [...(await fs.readFile(path.join(root, stats), 'utf8')).matchAll(/All:([\d.]+)/g)].map(match => Number(match[1]));
    if (scores.length < 890) throw new Error('画质对照未覆盖完整片段');
    results.push({ videoEncoder, hardwareDecode, timings: result.timings, duration: result.duration, bytes: (await fs.stat(file)).size, ssim: +(scores.reduce((n, score) => n + score, 0) / scores.length).toFixed(6) });
    console.log(JSON.stringify(results.at(-1)));
  }
  await fs.writeFile(path.join(root, '.local/nvenc-benchmark-20261007.json'), JSON.stringify({ sample: 'synthetic 1080P/30fps, exact 5.1–35.1 second cut, full export/probe/decode path; no network; SSIM against decoded source', nvencQuality: Number(process.argv[2] || 27), folder, results }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
