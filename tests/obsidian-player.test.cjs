const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let handler, notices = [];
class Plugin {
  registerMarkdownPostProcessor(fn) { this.processor = fn; }
  registerDomEvent(doc, event, fn) { handler = fn; }
}
const sandbox = { module: { exports: {} }, require: () => ({ Plugin, Notice: class { constructor(text) { notices.push(text); } } }), document: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../obsidian-plugin/main.js'), 'utf8'), sandbox);
const Player = sandbox.module.exports;
test('paragraph time accepts mm:ss and hours, rejects malformed times', () => {
  assert.equal(Player.seconds('00:14'), 14);
  assert.equal(Player.seconds('01:02:03'), 3723);
  assert.equal(Player.seconds('12:99'), null);
  assert.equal(Player.seconds('正文'), null);
});
test('click seeks only matching media in its note and preserves paused state', () => {
  const plugin = new Player(); plugin.onload();
  let scrolled = false, selected = false;
  const other = { src: 'other.mp4', currentTime: 7 };
  const video = { src: 'clip.mp4', duration: 30, paused: true, currentTime: 0, pause() { this.paused = true; }, scrollIntoView() { scrolled = true; } };
  const root = { querySelectorAll: selector => selector === 'video' ? [other, video] : [] };
  const button = { dataset: { resource: 'clip.mp4', seconds: '14' }, closest: selector => selector === '.bili-peek-reader' ? null : root, classList: { add() { selected = true; } } };
  handler({ target: { closest: () => button }, preventDefault() {}, stopPropagation() {} });
  assert.equal(video.currentTime, 14); assert.equal(video.paused, true); assert.equal(other.currentTime, 7);
  assert.equal(scrolled, true); assert.equal(selected, true);
  video.paused = false; assert.equal(Player.seek(video, 20), true); assert.equal(video.paused, false);
  assert.equal(Player.seek(video, 31), false); assert.equal(video.currentTime, 20);
  video.duration = NaN; assert.equal(Player.seek(video, 10), false);
});
test('reader parses paragraph times without changing text or including later note sections', () => {
  const result = Player.paragraphs('## 片段字幕\n\n时间以片段起点为 00:00。\n\n**00:01**\n\n原文第一段\n\n**00:14**\n\n第二段原文\n\n## 我的想法\n\n不属于字幕');
  assert.equal(result.length, 2);
  assert.equal(result[1].time, 14); assert.equal(result[1].text, '第二段原文');
});
test('deleted-note cleanup trashes only unused Bili-Peek videos and protects shared references', async () => {
  const orphan = { path: '网页内容/Bili-Peek附件/' + 'a'.repeat(20) + '.mp4', name: 'a'.repeat(20) + '.mp4' };
  const shared = { path: '网页内容/Bili-Peek附件/' + 'b'.repeat(20) + '.mp4', name: 'b'.repeat(20) + '.mp4' };
  const elsewhere = { path: 'assets/' + orphan.name, name: orphan.name };
  const note = { path: 'shared.md', extension: 'md' }; const trashed = [];
  const vault = { getFiles: () => [orphan, shared, elsewhere, note], cachedRead: async () => shared.name, trash: async (file, system) => { assert.equal(system, true); trashed.push(file.path); } };
  assert.equal(await Player.trashUnreferenced(vault, new Set([orphan.name, shared.name])), 1);
  assert.deepEqual(trashed, [orphan.path]);
  vault.cachedRead = async () => { throw new Error('unreadable'); };
  await assert.rejects(Player.trashUnreferenced(vault, new Set([shared.name])));
  assert.equal(trashed.length, 1);
});
