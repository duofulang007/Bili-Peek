const fs = require('node:fs/promises');
const path = require('node:path');
const { signWbi } = require('./server.cjs');
const { exportClip, run } = require('./export.cjs');
const id = process.argv[2] || 'BV1xx411c7mD';
const configPath = path.resolve(__dirname, '../.local/export-config.json');
async function get(url) {
  const response = await fetch(url, { headers: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`远程请求失败（${response.status}）`);
  return response.json();
}
(async () => {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const info = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`);
  if (info.code !== 0) throw new Error(`视频信息接口返回 ${info.code}`);
  const page = info.data.pages[0];
  const player = await get(`https://api.bilibili.com/x/player/wbi/v2?bvid=${id}&cid=${page.cid}`);
  const captions = player.data?.subtitle?.subtitles || [];
  if (!captions.length) {
    console.log(JSON.stringify({ video: id, metadata: 'verified', cid: page.cid, duration: page.duration, playerCode: player.code, subtitles: 'unavailable', loginRequired: Boolean(player.data?.need_login_subtitle) }));
    if (!process.argv.includes('--media-only')) return;
  }
  const chosen = captions.find(item => /^zh|^ai-zh/.test(item.lan)) || captions[0];
  const body = chosen ? await get(new URL(chosen.subtitle_url, 'https://www.bilibili.com').href) : null;
  if (process.argv.includes('--probe-only')) { console.log(JSON.stringify({ video: id, subtitles: 'verified', cues: body.body?.length })); return; }
  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  const wbi = nav.data.wbi_img;
  const filename = url => new URL(url).pathname.split('/').at(-1).split('.')[0];
  const signed = signWbi({ key: filename(wbi.img_url) + filename(wbi.sub_url), params: { bvid: id, cid: page.cid, qn: 64, fnval: 16, fourk: 0 } });
  const streams = await get(`https://api.bilibili.com/x/player/wbi/playurl?${signed}`);
  const video = streams.data?.dash?.video?.find(item => item.codecs?.startsWith('avc'));
  const audio = streams.data?.dash?.audio?.[0];
  if (!video || !audio) throw new Error(`无法获取媒体轨道（${streams.code}）`);
  if (process.argv.includes('--media-only')) {
    const duration = process.argv.includes('--performance') ? Math.min(120, page.duration - 10) : 5;
    const output = process.argv.includes('--performance') ? path.resolve(__dirname, `../.local/live-performance-${Date.now()}.mp4`) : path.resolve(__dirname, '../.local/live-sample.mp4');
    const began = performance.now();
    const input = url => ['-headers', 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n', '-ss', '10', '-i', url];
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...input(video.baseUrl || video.base_url), ...input(audio.baseUrl || audio.base_url), '-map', '0:v:0', '-map', '1:a:0', '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', output]);
    const mediaSeconds = +((performance.now() - began) / 1000).toFixed(2);
    const result = JSON.parse(await run(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    if (!result.streams.some(stream => stream.codec_type === 'video') || !result.streams.some(stream => stream.codec_type === 'audio') || Math.abs(Number(result.format.duration) - duration) > .15) throw new Error('真实媒体核验失败');
    const verifyBegan = performance.now();
    await run(config.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', output, '-f', 'null', '-']);
    console.log(JSON.stringify({ video: id, media: 'verified', duration: result.format.duration, mediaSeconds, verifySeconds: +((performance.now() - verifyBegan) / 1000).toFixed(2), subtitles: captions.length ? 'available' : 'login-required-or-absent', output })); return;
  }
  const start = Math.floor(body.body[0].from), end = Math.min(page.duration, start + 10);
  const task = { id, part: 1, cid: page.cid, start, end, title: info.data.title, tags: ['验收'], subtitles: body.body, subtitleSource: chosen.lan_doc, videoUrl: video.baseUrl || video.base_url, audioUrl: audio.baseUrl || audio.base_url };
  const result = await exportClip(task, config);
  console.log(JSON.stringify({ state: 'complete', video: id, start, end, note: result.notePath }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
