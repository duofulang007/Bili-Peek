const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { selectCues, srt, validateTask, exportClip, run, keyFor, readingParagraphs, note, mediaCheck } = require('../helper/export.cjs');
const { signWbi } = require('../helper/server.cjs');
const root = path.resolve(__dirname, '..');
const task = { id: 'BV1xx411c7mD', part: 2, cid: 123, start: 2.4, end: 3.7, videoUrl: 'https://test.bilivideo.com/video.m4s', audioUrl: 'https://test.bilivideo.com/audio.m4s', title: '测试视频', tags: ['测试'], noteName: '自定义笔记', summary: '这是一段简介', subtitles: [{ from: 0, to: 2.4, content: '区间之前' }, { from: 2, to: 3, content: '起点跨句' }, { from: 3, to: 3.5, content: '完整一句' }, { from: 3.5, to: 4, content: '终点跨句' }, { from: 3.7, to: 5, content: '区间之后' }] };

test('subtitle boundaries exclude adjacent cues and rebase clipped sentences', () => {
  const cues = selectCues(task.subtitles, 2.4, 3.7);
  assert.deepEqual(cues.map(cue => cue.content), ['起点跨句', '完整一句', '终点跨句']);
  assert.equal(cues[0].from, 0); assert.ok(Math.abs(cues[2].to - 1.3) < 1e-9);
  assert.equal(cues[0].clipped, true); assert.equal(cues[1].clipped, false);
  assert.match(srt(cues), /00:00:00,000 --> 00:00:00,600/);
  assert.match(srt(cues), /00:00:01,100 --> 00:00:01,300/);
});
test('reading text joins fragments without rewriting and breaks at pauses or existing sentence ends', () => {
  const cues = [
    { from: 0, to: 3, content: '第一句' }, { from: 3, to: 5, content: '仍然是原文。' },
    { from: 7, to: 9, content: '保留重复' }, { from: 9, to: 11, content: '保留重复' },
    { from: 11, to: 13, content: 'OpenAI' }, { from: 13, to: 15, content: 'API' }
  ];
  assert.equal(readingParagraphs(cues), '第一句仍然是原文。\n\n保留重复保留重复OpenAI API');
  const long = '内容'.repeat(95) + '。';
  assert.equal(readingParagraphs([{ from: 0, to: 20, content: long }, { from: 20, to: 24, content: '下一句' }]), long + '\n\n下一句');
  const unpunctuated = '字'.repeat(420);
  assert.equal(readingParagraphs([{ from: 0, to: 30, content: unpunctuated }, { from: 30, to: 32, content: '未添加标点' }]), unpunctuated + '\n\n未添加标点');
});
test('note shows coherent paragraphs with only their starting time and removes old transcript layouts', () => {
  const cues = selectCues(task.subtitles, task.start, task.end);
  const markdown = note(task, cues, keyFor(task), 1.3, {});
  assert.match(markdown, /## 片段字幕/);
  assert.doesNotMatch(markdown, /^# /m);
  assert.match(markdown, /\*\*00:00\*\*\n\n起点跨句完整一句终点跨句/);
  assert.doesNotMatch(markdown, /片段正文|带时间原文|\[!quote\]|时间同步字幕文件|\.srt/);
  assert.match(markdown, /选区边界处保留字幕整句/);
  assert.equal(readingParagraphs([{ from: 1, to: 3, content: '原文。' }, { from: 14, to: 16, content: '下一段' }, { from: 16, to: 18, content: '原文' }], true), '**00:01**\n\n原文。\n\n**00:14**\n\n下一段原文');
  assert.equal(readingParagraphs([{ from: 3601, to: 3603, content: '长片段' }], true), '**01:00:01**\n\n长片段');
  assert.doesNotMatch(note({ ...task, summary: '' }, cues, keyFor(task), 1.3, {}), /\nsummary:/);
});
test('only Bilibili media, valid ranges and nonempty subtitles are accepted', () => {
  assert.equal(validateTask(task), task);
  for (const patch of [{ start: -1 }, { end: task.start }, { videoUrl: 'http://127.0.0.1/private' }, { audioUrl: 'https://bilivideo.com.attacker.example/a' }, { subtitles: [] }, { part: 0 }, { tags: [] }, { tags: ['123'] }, { tags: ['无效 标签'] }, { tags: ['///'] }]) assert.throws(() => validateTask({ ...task, ...patch }));
  assert.notEqual(keyFor(task), keyFor({ ...task, part: 1 }));
  assert.doesNotThrow(() => validateTask({ ...task, subtitles: [], videoOnly: true }));
  const videoOnlyNote = note({ ...task, subtitles: [], videoOnly: true }, [], keyFor(task), 1.3, {});
  assert.match(videoOnlyNote, /未保存字幕/); assert.doesNotMatch(videoOnlyNote, /带时间原文|\.srt/);
});
test('WBI signing only includes supported parameters and strips reserved symbols', () => {
  const result = new URLSearchParams(signWbi({ key: 'a'.repeat(64), params: { bvid: "BV1!'xx411c7mD", cid: 123, injected: 'no' } }));
  assert.equal(result.get('bvid'), 'BV1xx411c7mD'); assert.equal(result.has('injected'), false);
  assert.match(result.get('w_rid'), /^[a-f0-9]{32}$/);
});
test('short end accepts only proven source endings, still rejects incomplete media or missing tracks', () => {
  const probe = { format: { duration: '12.565333' }, streams: [{ codec_type: 'video', avg_frame_rate: '30/1' }, { codec_type: 'audio' }] };
  assert.equal(mediaCheck(probe, 13).valid, false);
  assert.equal(mediaCheck(probe, 13, 12.533333).valid, true);
  assert.equal(mediaCheck(probe, 13, 12.533333).atEnd, true);
  assert.equal(mediaCheck(probe, 13, 30).valid, false);
  assert.equal(mediaCheck(probe, 20, 12.533333).valid, false);
  assert.equal(mediaCheck({ ...probe, streams: [probe.streams[0]] }, 13, 12.533333).valid, false);
});
test('real off-keyframe media cut writes video, subtitles and note once', async () => {
  const testRoot = path.join(root, 'tests/export-sandbox'); await fs.mkdir(testRoot, { recursive: true });
  const vault = await fs.mkdtemp(path.join(testRoot, 'vault-')); await fs.mkdir(path.join(vault, '.obsidian'));
  const config = { vault, output: path.join(vault, '网页内容'), ffmpeg: path.join(root, '.tools/ffmpeg.exe'), ffprobe: path.join(root, '.tools/ffprobe.exe'), category: '测试片段', tags: ['验证'] };
  const source = path.join(vault, 'source.mp4');
  await run(config.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-g', '250', '-c:a', 'aac', source]);
  const localRunner = (executable, args, timeout, onProgress) => {
    const local = [];
    for (let i = 0; i < args.length; i++) {
      if (['-protocol_whitelist', '-rw_timeout', '-headers'].includes(args[i])) { i++; continue; }
      local.push(/^https:\/\/test\.bilivideo\.com\//.test(args[i]) ? source : args[i]);
    }
    return run(executable, local, timeout, onProgress);
  };
  const progress = [];
  const result = await exportClip(task, config, localRunner, update => progress.push(update));
  assert.deepEqual([...new Set(progress.map(update => update.stage))], ['prepare', 'media', 'probe', 'verify', 'write', 'complete']);
  assert.ok(progress.some(update => update.stage === 'media' && Number.isFinite(update.percent)));
  assert.ok(progress.some(update => update.stage === 'verify' && Number.isFinite(update.percent)));
  assert.ok(result.timings.total >= result.timings.media && Number.isFinite(result.timings.verify));
  assert.ok(Math.abs(result.duration - 1.3) <= .15, `actual duration ${result.duration}`);
  const markdown = await fs.readFile(result.notePath, 'utf8');
  assert.equal(result.filename, '自定义笔记.md');
  assert.match(markdown, /tags: \["测试"\]/);
  assert.match(markdown, /summary: "这是一段简介"/);
  assert.doesNotMatch(markdown, /\n(?:title|category|cid|part|actual_duration|subtitle_source|start_seconds|end_seconds):/);
  assert.match(markdown, /!\[\[Bili-Peek附件\/.*\.mp4\]\]/);
  assert.match(markdown, /起点跨句完整一句终点跨句/);
  assert.doesNotMatch(markdown, /区间之前|区间之后/);
  await assert.rejects(fs.access(path.join(config.output, 'Bili-Peek附件', `${result.key}.srt`)));
  const duplicate = await exportClip(task, config, () => { throw new Error('duplicate must not recut'); });
  assert.equal(duplicate.duplicate, true);
  await fs.writeFile(path.join(config.output, '同名笔记.md'), '已有笔记不要覆盖');
  const collision = await exportClip({ ...task, noteName: '同名笔记' }, config, localRunner);
  assert.match(collision.filename, /^同名笔记 - [a-f0-9]{8}\.md$/);
  assert.equal(await fs.readFile(path.join(config.output, '同名笔记.md'), 'utf8'), '已有笔记不要覆盖');
  const invalidConfig = { ...config, output: path.join(testRoot, 'outside-vault') };
  await assert.rejects(exportClip(task, invalidConfig, localRunner), /不在配置的仓库内/);
  await assert.rejects(exportClip({ ...task, start: 6, end: 7 }, config, localRunner), /没有字幕/);
  const onlyVideo = await exportClip({ ...task, start: 6, end: 7, subtitles: [], videoOnly: true, noteName: '无字幕片段' }, config, localRunner);
  assert.equal(onlyVideo.hasSubtitles, false);
  assert.match(await fs.readFile(onlyVideo.notePath, 'utf8'), /未保存字幕/);
  await assert.rejects(fs.access(path.join(config.output, 'Bili-Peek附件', onlyVideo.key + '.srt')));
  assert.equal(new URL(onlyVideo.obsidianUri).searchParams.get('path'), onlyVideo.notePath);
  const nearEnd = await exportClip({ ...task, start: 7, end: 9, subtitles: [], videoOnly: true, noteName: '源末尾片段' }, config, localRunner);
  assert.ok(Math.abs(nearEnd.duration - 1) < .15);
  assert.match(await fs.readFile(nearEnd.notePath, 'utf8'), /到达源文件末尾/);
  await assert.rejects(exportClip({ ...task, start: 1, end: 2, noteName: '失败清理' }, config, async (executable, args) => {
    await fs.writeFile(args.at(-1), 'partial'); throw new Error('模拟失败');
  }), /模拟失败/);
  assert.equal((await fs.readdir(path.join(config.output, 'Bili-Peek附件'))).some(name => name.startsWith('.pending-')), false);
});
