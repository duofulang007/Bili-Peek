const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = { module: { exports: {} }, require: () => ({ Plugin: class {}, ItemView: class {}, MarkdownRenderChild: class {}, Notice: class {} }) };
vm.runInNewContext(fs.readFileSync(require.resolve('../obsidian-plugin/main.js'), 'utf8'), sandbox);
const Player = sandbox.module.exports;

test('collapsed original-caption callouts parse CRLF and preserve personal-note edits', () => {
  const source = '> [!note]- 片段字幕\r\n> 时间以片段起点为 00:00。\r\n>\r\n> **00:03**\r\n>\r\n> 原文\r\n\r\n## 我的笔记\r\n\r\n笔记\r\n';
  assert.equal(Player.paragraphs(source)[0]?.text, '原文');
  assert.ok(Player.replaceNotes(source, '新笔记', '笔记').startsWith(source.slice(0, source.indexOf('## 我的笔记'))));
});

test('saving a note preserves typing performed while the write is pending', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  let complete; view.app = { vault: { process: async (_, transform) => { assert.match(transform('## 我的笔记\n\n旧笔记'), /第一稿/); await new Promise(resolve => { complete = resolve; }); } } };
  view.file = { path: 'clip.md' }; view.savedNotes = '旧笔记'; view.editor = { value: '第一稿' }; view.saved = {};
  plugin.settings.drafts['clip.md'] = '第一稿'; const saving = view.saveNotes();
  view.editor.value = '继续输入的新稿'; plugin.settings.drafts['clip.md'] = view.editor.value;
  complete(); await saving;
  assert.equal(view.editor.value, '继续输入的新稿'); assert.equal(view.savedNotes, '第一稿'); assert.equal(plugin.settings.drafts['clip.md'], '继续输入的新稿');
});

test('search highlights exact repeated words and fuzzy characters at original Unicode positions', () => {
  const marked = (text, query) => [...(Player.captionMatches(text, query) || [])].sort((a, b) => a - b).map(index => text[index]).join('');
  assert.equal(marked('字幕，字幕', '字幕'), '字幕字幕');
  assert.equal(marked('听这个名字就讨厌三婚', '名婚'), '名婚');
  assert.equal(marked('Hello, WORLD！', 'ＨＷ'), 'HW');
  assert.equal(marked('名字 三婚', '名字 三婚'), '名字三婚');
  assert.equal(marked('你好世界', ''), '');
  assert.equal(Player.captionMatches('字幕', '不存在'), null);
  assert.equal(marked('😀字幕', '字幕'), '字幕');
});

test('search matches only displayed language and clearing immediately restores automatic following', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  const row = { offsetTop: 300, setAttribute() {}, removeAttribute() {} };
  view.rows = [{ item: { time: 0, text: 'Hello world' }, text: 'Hello world', searchText: 'Hello world\n你好世界', row }];
  view.captionSearch = { value: '你界' }; view.searchStatus = {}; view.transcript = { scrollTop: 0, clientHeight: 90 }; view.video = { currentTime: 7 }; view.followEnabled = true; view.lastActive = 0;
  view.filterCaptions(); assert.equal(row.hidden, true, 'hidden translation must not match original-only display');
  view.captionSearch.value = ''; view.filterCaptions(); assert.equal(row.hidden, false); assert.equal(view.transcript.scrollTop, 270, 'clearing must follow even within the same cue');
  view.followEnabled = false; view.captionSearch.value = 'world'; view.filterCaptions(); view.captionSearch.value = ''; view.filterCaptions(); assert.equal(view.transcript.scrollTop, 0, 'manual follow preference must remain off');
});

test('caption search supports fuzzy words, Unicode, translations and clearing without changing playback', async () => {
  assert.equal(Player.matchesCaption('听这个名字就讨厌三婚', '名字 三婚'), true);
  assert.equal(Player.matchesCaption('听这个名字就讨厌三婚', '名婚'), true);
  assert.equal(Player.matchesCaption('Hello, WORLD！', 'ＨＷ'), true);
  assert.equal(Player.matchesCaption('三婚名字', '名婚'), false);
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  const row = () => ({ setAttribute() {}, removeAttribute() {} });
  view.rows = [{ item: { time: 0, text: 'Hello world' }, text: 'Hello world\n你好世界', row: row() }, { item: { time: 5, text: '第二句' }, row: row() }];
  view.captionSearch = { value: '你界' }; view.searchStatus = {}; view.transcript = { scrollTop: 80 }; view.video = { currentTime: 7, paused: true };
  view.filterCaptions(); assert.equal(view.rows[0].row.hidden, false); assert.equal(view.rows[1].row.hidden, true); assert.match(view.searchStatus.textContent, /1 \/ 2/);
  view.captionSearch.value = '不存在'; view.filterCaptions(); assert.match(view.searchStatus.textContent, /更短/);
  view.captionSearch.value = ''; view.filterCaptions(); assert.ok(view.rows.every(({ row }) => !row.hidden)); assert.equal(view.searchStatus.textContent, '');
  assert.equal(view.video.currentTime, 7); assert.equal(view.video.paused, true);
  view.rows = []; view.captionSearch.value = '字幕'; view.filterCaptions(); assert.match(view.searchStatus.textContent, /没有可搜索/);
});

test('timestamp parsing and seeking retain pause state and reject invalid ranges', () => {
  assert.equal(Player.seconds('00:14'), 14); assert.equal(Player.seconds('01:02:03'), 3723);
  assert.equal(Player.seconds('12:99'), null);
  const video = { duration: 30, paused: true, currentTime: 0, pause() { this.paused = true; } };
  assert.equal(Player.seek(video, 14), true); assert.equal(video.currentTime, 14); assert.equal(video.paused, true);
  video.paused = false; Player.seek(video, 20); assert.equal(video.paused, false);
  assert.equal(Player.seek(video, -1), false); assert.equal(Player.seek(video, 31), false);
});

test('original and Buzz sections remain separate, personal-note writes preserve both', () => {
  const source = '---\nsource_has_subtitles: false\n---\n\n![[Bili-Peek附件/' + 'a'.repeat(20) + '.mp4]]\n\n## 片段字幕\n\n**00:01**\n\n原字幕原文\n\n## 语音识别稿\n\n**00:13**\n\n识别原文\n\n## 我的笔记\n\n旧笔记\n';
  const info = Player.noteInfo(source);
  assert.equal(info.sourceHasSubtitles, false); assert.equal(info.original.length, 1);
  assert.equal(Player.paragraphs(source, '语音识别稿')[0].text, '识别原文');
  const next = Player.replaceNotes(source, '新笔记 $&', '旧笔记');
  assert.equal(next.slice(0, next.indexOf('## 我的笔记')), source.slice(0, source.indexOf('## 我的笔记')));
  assert.ok(next.includes('新笔记 $&'));
  assert.throws(() => Player.replaceNotes(source, '新内容', '其他旧内容'), /草稿已保留/);
});

test('unknown subtitle state stays unknown and note parser excludes later sections', () => {
  assert.equal(Player.noteInfo('## 我的笔记\n\nsource_has_subtitles: false').sourceHasSubtitles, undefined);
  const rows = Player.paragraphs('## 片段字幕\n\n**00:14**\n\n原文\n\n## 我的笔记\n\n个人内容');
  assert.equal(rows.length, 1); assert.equal(rows[0].text, '原文');
});

test('deleted-note cleanup keeps referenced videos and stops on unreadable references', async () => {
  const orphan = { path: '网页内容/Bili-Peek附件/' + 'a'.repeat(20) + '.mp4', name: 'a'.repeat(20) + '.mp4' };
  const shared = { path: '网页内容/Bili-Peek附件/' + 'b'.repeat(20) + '.mp4', name: 'b'.repeat(20) + '.mp4' };
  const note = { path: 'shared.md', extension: 'md' }, trashed = [];
  const vault = { getFiles: () => [orphan, shared, note], cachedRead: async () => shared.name, trash: async file => trashed.push(file.path) };
  assert.equal(await Player.trashUnreferenced(vault, new Set([orphan.name, shared.name])), 1); assert.deepEqual(trashed, [orphan.path]);
  vault.cachedRead = async () => { throw Error('unreadable'); };
  await assert.rejects(Player.trashUnreferenced(vault, new Set([shared.name]))); assert.equal(trashed.length, 1);
});
function workbenchPlugin() {
  let factory;
  class Base {
    async loadData() { return {}; }
    async saveData() {}
    registerView(type, create) { factory = create; }
    addCommand() {}
    registerEvent() {}
    registerMarkdownPostProcessor() {}
  }
  const context = { module: { exports: {} }, require: () => ({ Plugin: Base, ItemView: class {}, Notice: class {} }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../obsidian-plugin/main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  plugin.app = { vault: { on() {}, getMarkdownFiles() { throw Error('startup must not scan vault'); } }, workspace: { on() {}, onLayoutReady() {} } };
  return { plugin, create: leaf => factory(leaf) };
}

test('startup does not read all notes; repeated clicks create one workbench and retain its video', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload();
  const leaves = []; let created = 0, initialized = 0;
  plugin.app.workspace = {
    getLeavesOfType: () => leaves,
    getLeaf() {
      created++;
      const leaf = { view: create({}), async setViewState(state) { initialized++; await Promise.resolve(); this.view.file = { path: state.state.file }; leaves.push(this); }, async loadIfDeferred() {}, async revealLeaf() {} };
      return leaf;
    },
    async revealLeaf() {}
  };
  const file = { path: 'clip.md', extension: 'md' };
  await Promise.all([plugin.openNote(file), plugin.openNote(file), plugin.openNote(file)]);
  assert.equal(created, 1); assert.equal(initialized, 1);
});

test('two notes coexist in separate workbench tabs and repeated opening removes only unchanged duplicate leaves', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload();
  const source = '视频笔记', files = ['a.md', 'b.md'].map(path => ({ path, extension: 'md' }));
  const workbench = { view: create({}), async setViewState(state) { this.view.file = { path: state.state.file }; }, async loadIfDeferred() {} };
  workbench.view.file = files[0]; let detached = 0;
  const leaves = [workbench];
  plugin.app.workspace = { getLeavesOfType: () => leaves, async revealLeaf() {}, getLeaf() { throw Error('must use incoming tab'); } };
  for (const file of [files[1], files[0], files[1]]) {
    const incoming = { view: { file, getViewType: () => 'markdown', editor: { getValue: () => source } }, async setViewState() { this.view = create({}); this.view.file = file; leaves.push(this); }, detach() { detached++; } };
    plugin.app.workspace.activeLeaf = incoming; await plugin.openNote(file, false, incoming, source);
  }
  assert.equal(detached, 2); assert.equal(leaves.length, 2);
  assert.deepEqual(leaves.map(leaf => leaf.view.file.path), ['a.md', 'b.md']);
  const incoming = { view: { file: files[0], getViewType: () => 'markdown', editor: { getValue: () => source } }, detach() { throw Error('new edits must remain open'); } };
  plugin.app.workspace.activeLeaf = incoming;
  plugin.app.workspace.revealLeaf = async () => { incoming.view.editor.getValue = () => '未保存的新输入'; };
  await plugin.openNote(files[0], false, incoming, source);
  const pinned = { view: { file: files[1], getViewType: () => 'markdown', editor: { getValue: () => source } }, getViewState: () => ({ pinned: true }), detach() { throw Error('pinned tab must stay open'); } };
  plugin.app.workspace.activeLeaf = pinned; await plugin.openNote(files[1], false, pinned, source);
});

test('first automatic opening converts the incoming tab without creating another leaf', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const file = { path: 'clip.md', extension: 'md' }, source = '视频笔记';
  const leaf = { view: { file, editor: { getValue: () => source } }, async setViewState() { this.view = create({}); this.view.file = file; } };
  plugin.app.workspace = { activeLeaf: leaf, getLeavesOfType: () => [], getLeaf() { throw Error('must convert incoming tab'); }, async revealLeaf() {} };
  await plugin.openNote(file, false, leaf, source); assert.equal(leaf.view.getViewType(), 'bili-peek-workbench');
});

test('note and recognition updates reach the matching second workbench tab', async () => {
  const { plugin } = workbenchPlugin(); const events = {};
  plugin.app.vault.on = (type, callback) => { events[type] = callback; }; await plugin.onload();
  const updates = [0, 0], views = ['a', 'b'].map((name, index) => ({ file: { path: name + '.md' }, asrPath: name + '.buzz.json', async setFile() { updates[index]++; } }));
  plugin.app.workspace.getLeavesOfType = () => views.map(view => ({ view }));
  events.modify({ path: 'b.md' }); events.create({ path: 'b.buzz.json' });
  assert.deepEqual(updates, [0, 2]);
});

test('opening original notes concurrently reuses existing Markdown tabs', async () => {
  const { plugin } = workbenchPlugin(); await plugin.onload(); const leaves = []; let created = 0;
  plugin.app.workspace = { getLeavesOfType: () => leaves, async revealLeaf() {}, getLeaf() { created++; const leaf = { view: {}, async openFile(file) { await Promise.resolve(); this.view.file = file; } }; leaves.push(leaf); return leaf; } };
  const files = ['a.md', 'b.md'].map(path => ({ path, extension: 'md' }));
  await Promise.all([plugin.openMarkdown(files[0]), plugin.openMarkdown(files[0]), plugin.openMarkdown(files[1]), plugin.openMarkdown(files[0])]);
  assert.equal(created, 2);
});

test('subtitle updates touch only previous and current rows rather than every subtitle', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  let touched = 0;
  view.rows = Array.from({ length: 10000 }, (_, time) => ({ item: { time }, row: { setAttribute() { touched++; }, removeAttribute() { touched++; } } }));
  view.video = { currentTime: 0 }; view.follow = { checked: false }; view.lastActive = -1;
  view.highlight(); view.video.currentTime = 5000; view.highlight(); view.highlight();
  assert.ok(touched <= 3, `updated ${touched} rows`); assert.equal(view.lastActive, 5000);
});

test('automatic view changes refuse an unloaded or edited Markdown editor', async () => {
  const { plugin } = workbenchPlugin(); await plugin.onload();
  const file = { path: 'clip.md', extension: 'md' }, leaf = { view: { file, editor: { getValue: () => '' } } };
  plugin.app.workspace = { activeLeaf: leaf, getLeaf() { throw Error('must not switch empty editor'); } };
  await plugin.openNote(file, false, leaf, '![[Bili-Peek附件/aaaaaaaaaaaaaaaaaaaa.mp4]]');
  leaf.view.editor.getValue = () => '未保存的修改';
  await plugin.openNote(file, false, leaf, '![[Bili-Peek附件/aaaaaaaaaaaaaaaaaaaa.mp4]]');
});

test('collapsed recognition callouts retain timestamped text and personal notes', () => {
  const source = '> [!note]- 语音识别稿\n> 来源：Buzz\n>\n> **00:13**\n>\n> 识别原文\n\n## 我的笔记\n\n个人内容\n';
  const rows = Player.paragraphs(source, '语音识别稿');
  assert.equal(rows.length, 1); assert.equal(rows[0].text, '识别原文');
  assert.equal(Player.noteInfo(source).notes, '个人内容');
  assert.ok(Player.replaceNotes(source, '新的个人内容', '个人内容').startsWith(source.slice(0, source.indexOf('## 我的笔记'))));
});

test('a stale translation cache cannot replace the current original subtitles', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  view.app = { vault: { adapter: { async exists() { return true; }, async read() { return JSON.stringify({ direction: 'en-zh', source: [{ time: 0, text: 'Different source' }], texts: ['旧译文'] }); } } } };
  view.kind = 'asr'; view.asr = [{ time: 0, text: 'Current English subtitle' }]; view.asrPath = 'clip.buzz.json';
  view.translationStatus = { textContent: '' }; view.languageButtons = {}; view.foldCaptions = () => {}; view.showSource = () => {};
  await view.setLanguage('zh');
  assert.equal(view.language, 'original'); assert.equal(view.translations, undefined);
  assert.equal(view.asr[0].text, 'Current English subtitle'); assert.match(view.translationStatus.textContent, /翻译失败/);
});

test('mode switching keeps playback and remembers separate video widths', async () => {
  const { plugin, create } = workbenchPlugin(); await plugin.onload(); const view = create({});
  view.root = { dataset: {}, style: { setProperty() {} } }; view.modeButton = { setAttribute() {} }; view.width = {}; view.widthValue = {};
  view.video = { src: 'clip.mp4', currentTime: 18, paused: false };
  view.mode('watch'); assert.equal(view.width.value, '62');
  plugin.settings.writeShare = 55; view.mode('write'); assert.equal(view.width.value, '55');
  view.mode('watch'); assert.equal(view.width.value, '62'); assert.equal(plugin.settings.mode, 'watch');
  assert.equal(view.video.src, 'clip.mp4'); assert.equal(view.video.currentTime, 18); assert.equal(view.video.paused, false);
});
