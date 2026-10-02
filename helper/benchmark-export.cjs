const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { run } = require('./export.cjs');
(async () => {
  const root = path.resolve(__dirname, '..');
  const folder = await fs.mkdtemp(path.join(root, '.local/benchmark-'));
  const ffmpeg = path.join(root, '.tools/ffmpeg.exe');
  const source = path.join(folder, 'source.mp4');
  await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  const results = [];
  for (const preset of ['fast', 'veryfast']) {
    const file = path.join(folder, preset + '.mp4');
    let began = performance.now();
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-stream_loop', '-1', '-i', source, '-t', '120', '-c:v', 'libx264', '-preset', preset, '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', file]);
    const encodeSeconds = (performance.now() - began) / 1000;
    began = performance.now();
    await run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-f', 'null', '-']);
    results.push({ preset, encodeSeconds: +encodeSeconds.toFixed(2), verifySeconds: +((performance.now() - began) / 1000).toFixed(2), bytes: (await fs.stat(file)).size });
    console.log(JSON.stringify(results.at(-1)));
  }
  await fs.writeFile(path.join(root, '.local/export-benchmark.json'), JSON.stringify({ sample: 'synthetic 120 seconds, 1280x720, 25 fps, local input; no network', results }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
