const { Plugin, Notice } = require('obsidian');

function seconds(text) {
  if (!/^\d{2,}:\d{2}(?::\d{2})?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(n => n > 59)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function seek(video, time) {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || time > video.duration) return false;
  const paused = video.paused;
  video.currentTime = time;
  if (paused) video.pause();
  return true;
}

function paragraphs(source) {
  const section = source.split('## 片段字幕')[1];
  if (!section) return [];
  return [...section.split(/\n## /)[0].matchAll(/\*\*(\d{2,}:\d{2}(?::\d{2})?)\*\*\s*\n([\s\S]*?)(?=\n\*\*\d{2,}:\d{2}(?::\d{2})?\*\*|$)/g)]
    .map(match => ({ label: match[1], time: seconds(match[1]), text: match[2].trim() })).filter(item => item.time !== null && item.text);
}

function makeReader(items, resource) {
  const reader = document.createElement('section'); reader.className = 'bili-peek-reader';
  reader.setAttribute('aria-label', '视频和片段字幕');
  const video = document.createElement('video'); video.src = resource; video.controls = true; video.preload = 'metadata'; video.playsInline = true;
  const transcript = document.createElement('div'); transcript.className = 'bili-peek-transcript'; transcript.tabIndex = 0; transcript.setAttribute('aria-label', '片段字幕，独立滚动');
  for (const item of items) {
    const paragraph = document.createElement('div'); paragraph.className = 'bili-peek-paragraph';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'bili-peek-time'; button.textContent = item.label;
    button.title = `跳转片段到 ${item.label}`; button.dataset.seconds = String(item.time); button.dataset.resource = resource;
    const text = document.createElement('p'); text.textContent = item.text;
    paragraph.append(button, text); transcript.append(paragraph);
  }
  reader.append(video, transcript); return reader;
}

async function trashUnreferenced(vault, names) {
  const documents = vault.getFiles().filter(file => ['md', 'canvas', 'base'].includes(file.extension));
  // A failed read aborts cleanup rather than assuming there are no references.
  const contents = await Promise.all(documents.map(file => vault.cachedRead(file)));
  let removed = 0;
  for (const file of vault.getFiles()) {
    if (!/\/Bili-Peek附件\/[a-f0-9]{20}\.mp4$/.test('/' + file.path) || !names.has(file.name)) continue;
    if (contents.some(text => text.includes(file.name))) continue;
    await vault.trash(file, true); removed++;
  }
  return removed;
}

module.exports = class BiliPeekPlayer extends Plugin {
  onload() {
    this.layouts = new Map();
    this.duplicateTitles = new Set();
    if (this.app?.vault?.on) this.trackAttachments();
    this.registerMarkdownPostProcessor(async (element, context) => {
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!file) return;
      const source = await this.app.vault.cachedRead(file);
      const match = source.match(/!\[\[(Bili-Peek附件\/[a-f0-9]{20}\.mp4)\]\]/);
      if (!match) return;
      const originalTitle = source.match(/^# (.+)$/m)?.[1];
      for (const title of element.querySelectorAll('h1')) if (title.textContent.trim() === originalTitle) {
        title.classList.add('bili-peek-original'); this.duplicateTitles.add(title);
      }
      if (!source.includes('## 片段字幕')) return;
      const asset = this.app.metadataCache.getFirstLinkpathDest(match[1], context.sourcePath);
      if (!asset) return;
      const resource = this.app.vault.getResourcePath(asset);
      const items = paragraphs(source);
      const root = element.closest('.markdown-preview-view');
      if (root && items.length) {
        const heading = [...element.querySelectorAll('h2')].find(item => item.textContent.trim() === '片段字幕');
        if (heading && !root.querySelector('.bili-peek-reader')) {
          const reader = makeReader(items, resource); heading.after(reader);
          const hidden = new Set();
          const originalTexts = new Set(items.flatMap(item => [item.label, item.text]));
          const hideOriginals = () => {
            for (const paragraph of root.querySelectorAll('p')) {
              if (paragraph.closest('.bili-peek-reader')) continue;
              const originalVideo = [...paragraph.querySelectorAll('video')].find(video => (video.currentSrc || video.src) === resource);
              if (originalVideo || originalTexts.has(paragraph.textContent.trim()) || paragraph.textContent.startsWith('时间以片段起点为 00:00。')) {
                if (originalVideo) originalVideo.pause();
                paragraph.classList.add('bili-peek-original'); hidden.add(paragraph);
              }
            }
          };
          hideOriginals();
          const observer = new MutationObserver(hideOriginals); observer.observe(root, { childList: true, subtree: true });
          const previous = this.layouts.get(root); if (previous) { previous.observer.disconnect(); previous.hidden.forEach(item => item.classList.remove('bili-peek-original')); }
          this.layouts.set(root, { reader, observer, hidden });
        }
        if (root.querySelector('.bili-peek-reader')) return;
      }
      for (const strong of element.querySelectorAll('p > strong')) {
        const time = seconds(strong.textContent.trim());
        if (time === null || strong.parentElement.textContent.trim() !== strong.textContent.trim()) continue;
        const button = document.createElement('button');
        button.className = 'bili-peek-time'; button.textContent = strong.textContent;
        button.type = 'button'; button.title = `跳转片段到 ${strong.textContent}`;
        button.dataset.seconds = String(time); button.dataset.resource = resource;
        strong.replaceWith(button);
      }
    });
    this.registerDomEvent(document, 'click', event => {
      const button = event.target.closest?.('button.bili-peek-time');
      if (!button) return;
      event.preventDefault(); event.stopPropagation();
      const root = button.closest('.markdown-preview-view, .markdown-rendered');
      const reader = button.closest('.bili-peek-reader');
      const video = [...((reader || root)?.querySelectorAll('video') || [])].find(item => (item.currentSrc || item.src) === button.dataset.resource);
      if (!video) { new Notice('当前笔记的视频尚未显示，请先打开视频所在位置。'); return; }
      if (!seek(video, Number(button.dataset.seconds))) {
        new Notice('视频尚未加载完成，或时间超出片段范围，请稍后重试。'); return;
      }
      if (!reader) video.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      root.querySelectorAll('.bili-peek-time.is-selected').forEach(item => item.classList.remove('is-selected'));
      button.classList.add('is-selected');
    });
  }
  trackAttachments() {
    const vault = this.app.vault, references = new Map();
    const remember = async file => {
      if (file.extension !== 'md') return;
      try {
        const text = await vault.cachedRead(file);
        references.set(file.path, new Set(text.match(/[a-f0-9]{20}\.mp4/g) || []));
      } catch { references.delete(file.path); }
    };
    vault.getMarkdownFiles().forEach(file => { void remember(file); });
    this.registerEvent(vault.on('create', file => { void remember(file); }));
    this.registerEvent(vault.on('modify', file => { void remember(file); }));
    this.registerEvent(vault.on('rename', (file, previous) => { references.delete(previous); void remember(file); }));
    this.registerEvent(vault.on('delete', file => {
      const names = references.get(file.path); references.delete(file.path);
      if (!names?.size) return;
      void trashUnreferenced(vault, names).catch(() => new Notice('未能核对附件引用，已保留视频，请稍后重试清理。'));
    }));
  }
  onunload() {
    this.duplicateTitles.forEach(title => title.classList.remove('bili-peek-original'));
    for (const { reader, observer, hidden } of this.layouts.values()) {
      observer.disconnect(); reader.remove(); hidden.forEach(item => item.classList.remove('bili-peek-original'));
    }
    this.layouts.clear();
    document.querySelectorAll('button.bili-peek-time').forEach(button => {
      const strong = document.createElement('strong'); strong.textContent = button.textContent; button.replaceWith(strong);
    });
  }
};
module.exports.seconds = seconds;
module.exports.seek = seek;
module.exports.paragraphs = paragraphs;
module.exports.makeReader = makeReader;
module.exports.trashUnreferenced = trashUnreferenced;
