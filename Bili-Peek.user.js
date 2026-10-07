// ==UserScript==
// @name         Bili-Peek · 弹幕观看助手
// @namespace    bili-peek
// @version      0.3.48
// @description  视频右侧双图：弹幕词云与可点击跳转的密度图，推荐视频保留在下方。
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      subtitle.bilibili.com
// @connect      127.0.0.1
// @grant        window.onurlchange
// ==/UserScript==

(() => {
  'use strict';

  const HOST_ID = 'bili-peek-panel';
  const RIGHT = '.right-container-inner, .right-container';
  const RECOMMEND = '.recommend-list-v1, .recommend-list, #reco_list, .rec-list';
  const PLAYER = '#bilibili-player, #bilibiliPlayer, .bpx-player-container';
  const MEDIA = 'video, bwp-video';
  const UP = '.up-panel-container, .up-info-container';

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const s = String(total % 60).padStart(2, '0');
    const m = Math.floor(total / 60) % 60;
    return total >= 3600
      ? `${Math.floor(total / 3600)}:${String(m).padStart(2, '0')}:${s}`
      : `${Math.floor(total / 60)}:${s}`;
  }

  function overallProgress(stage, percent, segmented, previous = 0) {
    const ranges = { prepare: [1, 0], source: [3, 0], download: [5, 75], media: segmented ? [80, 12] : [5, 87], probe: [92, 0], verify: [94, 5], transcribe: [99, 0], write: [99, 0], complete: [100, 0] };
    const [start, span] = ranges[stage] || [previous, 0];
    const fraction = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) / 100 : 0;
    return Math.max(previous, Math.round(start + span * fraction));
  }

  function routeKey(url) {
    const parsed = new URL(url);
    const id = parsed.pathname.match(/^\/video\/(BV[\da-z]+|av\d+)\/?$/i)?.[1];
    if (!id) return null;
    const rawPart = parsed.searchParams.get('p') || '1';
    const part = /^\d+$/.test(rawPart) && Number(rawPart) > 0 ? Number(rawPart) : 1;
    return `${id}:p${part}`;
  }

  function parsePageState(source, id) {
    const marker = /(?:window\.)?__INITIAL_STATE__\s*=\s*/.exec(source);
    if (!marker) return null;
    const start = marker.index + marker[0].length;
    if (source[start] !== '{') return null;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < Math.min(source.length, start + 2000000); i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const root = JSON.parse(source.slice(start, i + 1));
          const data = root.videoData;
          if (!data?.pages || !data.aid) return null;
          const matches = /^av/i.test(id) ? String(data.aid) === id.slice(2) : String(data.bvid).toLowerCase() === id.toLowerCase();
          return matches ? data : null;
        } catch { return null; }
      }
    }
    return null;
  }

  function seekMedia(media, seconds, signal) {
    return new Promise((resolve, reject) => {
      if (!media || media.isConnected === false || media.readyState < 1 || !Number.isFinite(media.duration) || media.duration <= 0) {
        reject(new Error('播放器尚未就绪，请等待视频加载。'));
        return;
      }
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > media.duration) {
        reject(new Error('该位置超出当前视频范围。'));
        return;
      }
      const target = Math.min(seconds, Math.max(0, media.duration - 0.05));
      let finished = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        for (const event of ['seeked', 'timeupdate']) media.removeEventListener(event, check);
        for (const event of ['emptied', 'loadstart', 'error']) media.removeEventListener(event, switched);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        error ? reject(error) : resolve({ target, actual: media.currentTime });
      };
      const check = () => {
        if (!media.seeking && media.readyState >= 1 && Math.abs(media.currentTime - target) <= 0.75) finish();
      };
      const switched = () => finish(new Error('播放器已切换或加载失败，请重新选择时间。'));
      const abort = () => finish(new Error('视频或分 P 已切换，本次定位已取消。'));
      if (signal?.aborted) { abort(); return; }
      for (const event of ['seeked', 'timeupdate']) media.addEventListener(event, check);
      for (const event of ['emptied', 'loadstart', 'error']) media.addEventListener(event, switched);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        check();
        if (!finished) finish(new Error('未能确认视频已定位，请稍后重试。'));
      }, 1800);
      try {
        // Setting currentTime preserves the player's play/pause state; do not call play().
        media.currentTime = target;
        queueMicrotask(check);
      } catch {
        finish(new Error('播放器暂时不能跳转，请等待加载后重试。'));
      }
    });
  }

  // Small protobuf reader: only fields required for timeline/text statistics are retained.
  function decodeDanmaku(buffer) {
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pos = 0;
    function varint(end) {
      let result = 0n;
      for (let i = 0; i < 10 && pos < end; i++) {
        const b = bytes[pos++];
        if (i === 9 && b > 1) throw new Error('无效弹幕数据');
        result |= BigInt(b & 127) << BigInt(i * 7);
        if (!(b & 128)) return result;
      }
      throw new Error('弹幕数据不完整');
    }
    function fields(end, handle) {
      while (pos < end) {
        const tag = Number(varint(end));
        const field = Math.floor(tag / 8), wire = tag & 7;
        if (!field) throw new Error('无效弹幕数据');
        let value;
        if (wire === 0) value = varint(end);
        else if (wire === 2) {
          const size = Number(varint(end));
          if (!Number.isSafeInteger(size) || size < 0 || pos + size > end) throw new Error('弹幕数据不完整');
          const finish = pos + size;
          if (handle(field, wire, { start: pos, end: finish }) === true) {
            if (pos !== finish) throw new Error('无效弹幕边界');
            continue;
          }
          pos = finish;
          continue;
        } else if (wire === 1 || wire === 5) {
          pos += wire === 1 ? 8 : 4;
          if (pos > end) throw new Error('弹幕数据不完整');
          continue;
        } else throw new Error('无效弹幕格式');
        handle(field, wire, value);
      }
    }
    const records = [];
    let state = 0;
    fields(bytes.length, (field, wire, value) => {
      if (field === 2 && wire === 0) state = Number(value);
      if (field !== 1 || wire !== 2) return false;
      const record = { id: '', time: 0, text: '', mode: 1, pool: 0 };
      fields(value.end, (f, w, v) => {
        if (w === 0) {
          if (f === 1) record.id = String(v);
          if (f === 2) record.time = Number(v) / 1000;
          if (f === 3) record.mode = Number(v);
          if (f === 11) record.pool = Number(v);
        }
        if (w === 2 && (f === 7 || f === 12)) {
          const text = decoder.decode(bytes.subarray(v.start, v.end));
          if (f === 7) record.text = text;
          else record.id = text;
        }
      });
      if (Number.isFinite(record.time) && record.time >= 0) records.push(record);
      return true;
    });
    return { records, state };
  }

  function density(records, duration, term = '') {
    const normalizedTerm = term ? normalize(term) : '';
    const width = Math.max(1, Math.ceil(duration / 160));
    const bins = Array.from({ length: Math.max(1, Math.ceil(duration / width)) }, (_, i) => ({ time: i * width, count: 0, selected: 0, samples: [] }));
    for (const record of records) {
      if (record.time < 0 || record.time > duration) continue;
      const bin = bins[Math.min(bins.length - 1, Math.floor(record.time / width))];
      bin.count++;
      const matches = !normalizedTerm || normalize(record.text).includes(normalizedTerm);
      if (normalizedTerm && matches) bin.selected++;
      if (matches && record.mode <= 6 && bin.samples.length < 3 && !bin.samples.includes(record.text)) bin.samples.push(record.text);
    }
    return { bins, width };
  }

  const STOP = new Set('的 了 是 在 我 你 他 她 它 这 那 有 和 就 都 也 啊 吧 呢 吗 哦 哈 哈哈 哈哈哈 可以 一个 什么 怎么 这个 那个 没有 不是 还是 然后 真的 感觉 但是 所以 现在 这样 这里 那里 这种 不 很 太 还 要 会 被 给 到 上 下 说 看 来 去 让 把 啥'.split(' '));
  const COMPOUNDS = new Set('服务器 金条 美光 主板 带宽 纠错 内存 显卡 硬盘 处理器 电源 芯片 固态硬盘 笔记本 台式机 人工智能 大模型 游戏 画质 帧率 涨价 降价 上涨 下跌'.split(' '));
  const TOKEN_SPLIT = new RegExp(`(${[...COMPOUNDS].sort((a, b) => b.length - a.length).join('|')}|[a-zA-Z0-9]+(?:[.+-][a-zA-Z0-9]+)*)`, 'g');
  const wordStatsCache = new WeakMap();
  function normalize(text) { return String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
  function wordStats(records, phrases = false) {
    let cached = wordStatsCache.get(records);
    if (cached?.has(phrases)) return cached.get(phrases);
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    const frequency = new Map();
    const textCache = new Map();
    for (const record of records) {
      if (record.mode > 6 || record.pool !== 0) continue;
      const previous = textCache.get(record.text);
      if (previous) { for (const term of previous) frequency.set(term, (frequency.get(term) || 0) + 1); continue; }
      const seen = new Set();
      let run = [];
      const flush = () => {
        if (phrases) for (let i = 0; i < run.length; i++) for (let n = 2; n <= 4 && i + n <= run.length; n++) {
          const term = run.slice(i, i + n).join('');
          if (term.length >= 3 && term.length <= 14) seen.add(term);
        }
        run = [];
      };
      // Keep hardware model numbers and units together; punctuation remains a boundary.
      for (const fragment of record.text.normalize('NFKC').split(TOKEN_SPLIT)) {
        const parts = /^[a-zA-Z0-9]/.test(fragment) || COMPOUNDS.has(fragment) ? [{ segment: fragment, isWordLike: true }] : segmenter.segment(fragment);
        for (const part of parts) {
          const word = part.segment.trim();
          if (!part.isWordLike || !word || STOP.has(word.toLowerCase())) { flush(); continue; }
          if (!phrases && word.length > 1) seen.add(word.toLowerCase());
          if (phrases) run.push(word.toLowerCase());
        }
      }
      flush();
      if (textCache.size < 2000) textCache.set(record.text, seen);
      for (const term of seen) frequency.set(term, (frequency.get(term) || 0) + 1);
    }
    textCache.clear();
    const terms = [];
    for (const [text, count] of frequency) if (!phrases || count >= 2) terms.push({ text, count });
    if (phrases) {
      // Retain only real candidates with the same count, not every possible substring.
      const nested = new Set();
      for (const { text, count } of terms) for (let start = 0; start < text.length - 2; start++) {
        for (let end = start + 3; end <= text.length; end++) {
          if (end - start >= text.length) continue;
          const shorter = text.slice(start, end);
          if (frequency.get(shorter) === count) nested.add(shorter);
        }
      }
      // Compact in place so filtering doesn't allocate a second candidate array.
      let kept = 0;
      for (const term of terms) if (!nested.has(term.text)) terms[kept++] = term;
      terms.length = kept;
    }
    frequency.clear();
    const result = terms.sort((a, b) => b.count - a.count || b.text.length - a.text.length || a.text.localeCompare(b.text)).slice(0, 80)
      .map(item => ({ ...item, text: item.text.replace(/ddr(\d)/g, 'DDR$1').replace(/(\d+)gb/g, '$1GB').replace(/hbm|ecc|cpu|gpu|ram|ssd|tsv/g, value => value.toUpperCase()) }));
    if (!cached) { cached = new Map(); wordStatsCache.set(records, cached); }
    cached.set(phrases, result); return result;
  }

  function mergeWatchRanges(ranges, start, end) {
    const sorted = [...ranges, [start, end]].filter(pair => Array.isArray(pair) && pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[0] >= 0 && pair[1] > pair[0]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const pair of sorted) {
      const last = merged.at(-1);
      if (last && pair[0] <= last[1] + .05) last[1] = Math.max(last[1], pair[1]);
      else merged.push([...pair]);
    }
    return merged;
  }
  function watchedAdvance(previous, current) {
    if (!previous || !previous.playing || !current.playing) return null;
    const wall = (current.wall - previous.wall) / 1000, delta = current.time - previous.time;
    if (wall <= 0 || wall > 3 || delta <= 0 || delta > wall * Math.max(previous.rate, current.rate) + .5) return null;
    return [previous.time, current.time];
  }

  // The same data and timing logic is checked in Node without a browser.
  function selectQualityStream(streams, quality) {
    const matching = (streams || []).filter(item => Number(item.id) === quality);
    return matching.find(item => item.codecs?.startsWith('avc')) || matching[0];
  }

  function selectMediaUrl(stream) {
    const candidates = [stream?.baseUrl, stream?.base_url,
      ...(Array.isArray(stream?.backupUrl) ? stream.backupUrl : []),
      ...(Array.isArray(stream?.backup_url) ? stream.backup_url : [])];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      try {
        const url = new URL(candidate);
        if (url.protocol === 'https:' && !url.username && !url.password && /(^|\.)bilivideo\.(com|cn)$/.test(url.hostname) && (!url.port || url.port === '443')) return candidate;
      } catch {}
    }
    return null;
  }

  function downloadQualities(data) {
    if (!data?.dash?.audio?.some(selectMediaUrl)) return [];
    const labels = { 16: '360P', 32: '480P', 64: '720P', 74: '720P 60帧', 80: '1080P', 112: '1080P 高码率', 116: '1080P 60帧', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' };
    return [...new Set((data.dash.video || []).filter(stream => selectMediaUrl(stream) && Number.isInteger(stream.id) && stream.id > 0).map(stream => stream.id))]
      .sort((a, b) => b - a).map(id => ({ id, label: data.support_formats?.find(format => format.quality === id)?.new_description || labels[id] || `画质 ${id}` }));
  }
  function defaultDownloadQuality(qualities) { return qualities.find(item => item.id === 80)?.id || qualities[0]?.id; }
  function folderMatches(folders, query) {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return folders.filter(folder => words.every(word => {
      let index = -1;
      for (const letter of word) { index = folder.toLocaleLowerCase().indexOf(letter, index + 1); if (index < 0) return false; }
      return true;
    })).sort((a, b) => Number(b.toLocaleLowerCase().includes(query.toLocaleLowerCase())) - Number(a.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || a.length - b.length || a.localeCompare(b, 'zh-CN')).slice(0, 8);
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { formatTime, overallProgress, routeKey, seekMedia, decodeDanmaku, density, wordStats, parsePageState, mergeWatchRanges, watchedAdvance, selectQualityStream, selectMediaUrl, downloadQualities, defaultDownloadQuality, folderMatches };
    return;
  }
  if (window.top !== window.self || document.getElementById(HOST_ID)) return;

  let host, ui, media, currentRoute, scheduled, pendingSeek;
  let seeking = false, restoreAfterRoute = false, loadedRoute = null;
  let records = [], videoDuration = 0, selectedTerm = '', phraseMode = false;
  let dataRoute = null, dataRequest = null, chartData = null, hoverTime = 0;
  let watchRoute = null, watchRanges = [], watchSample = null, watchStart = null, watchDirty = false, watchSavedAt = 0;
  let seekNoticeTimer;
  // 非空时表示「下一次 renderCharts 是从加载态落地」，落地后由 renderCharts 清空。
  let settleCharts = null;
  const exportDrafts = new Map();
  let clipRange = null, rangeDrag = null;
  const exportingRoutes = new Set(), transferStates = new Map();
  let helperOnline = false, helperFailures = 0, helperTimer, helperSync = 0, pageSuspended = false;
  const savedValue = (key, fallback) => typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
  const latestNotes = new Map(Object.entries(savedValue('latest-export-notes', {}) || {}));
  const managed = () => Boolean(savedValue('export-token', ''));
  let helperManaged = managed();
  const helperPort = () => {
    const port = Number(savedValue('export-port', 18766));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 18766;
  };
  const diagnostic = { started: Date.now(), reconciles: 0, charts: 0, mediaEvents: 0, clicks: 0, moves: 0, seeks: 0, lastSeek: null, lastError: '' };
  const cache = new Map();
  let alignedRail = null, originalRailMargin = '';
  let overlayCloseTimer;
  const SVG = 'http://www.w3.org/2000/svg';
  const styles = `
    :host{display:block;pointer-events:auto;width:100%;min-width:0;margin:0 0 18px;color-scheme:light;
      --bg:#fff;--text:#18191c;--muted:#61666d;--line:#e3e5e7;--accent:#5287d5;--fill:#5287d540;--shadow:#00000024;
      /* --live 是加载动效的品牌粉（装饰用，可低对比）；--live-ink 是内容态曲线/文字用的可读档。 */
      --live:#fb7299;--live-soft:#fb729926;--live-ink:#d63b6e;--live-ink-soft:#d63b6e26;
      color:var(--text);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
    :host([data-theme=dark]){color-scheme:dark;--bg:#18191b;--text:#eceef0;--muted:#a6a9af;--line:#36383c;--accent:#829eed;--fill:#6e8be96b;--shadow:#0009;--live:#fb7299;--live-soft:#fb729933;--live-ink:#fb7299;--live-ink-soft:#fb729933}
    :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}
    #edge-trigger,#overlay-pin{display:none}
    :host([data-overlay]){position:fixed;inset:24px 0 auto auto;width:min(372px,100vw);height:min(680px,calc(100dvh - 100px));margin:0;z-index:2147483647;--bg:#18191b55;--text:#eceef0;--muted:#c4c7ce;--line:#ffffff30;--accent:#829eed;--fill:#6e8be940;--live-ink:#fb7299;--live-ink-soft:#fb729926;text-shadow:0 1px 3px #000}
    :host([data-overlay]) #edge-trigger{display:block;position:fixed;right:0;top:24px;bottom:76px;width:10px;padding:0;border:0;background:transparent;pointer-events:auto}
    :host([data-overlay]) #edge-trigger:focus-visible{outline-offset:-3px}
    :host([data-overlay]) #panel-content{height:100%;padding-right:12px;display:flex;flex-direction:column;gap:12px;opacity:0;transform:translateX(100%);visibility:hidden;pointer-events:none;transition:transform 220ms cubic-bezier(.32,.72,0,1),opacity 220ms cubic-bezier(.23,1,.32,1),visibility 0s 220ms}
    :host([data-overlay][data-expanded]) #panel-content{opacity:1;transform:translateX(0);visibility:visible;pointer-events:auto;transition-delay:0s}
    :host([data-overlay]) #overlay-pin{display:grid;place-items:center;flex:none;margin-left:auto;width:28px;height:24px;padding:3px}
    :host([data-overlay]) #mode{margin-left:0}#overlay-pin svg{width:16px;height:16px}
    #overlay-pin[aria-pressed=true]{color:var(--accent);border-color:var(--accent);background:var(--fill)}
    :host([data-overlay]) figure{flex:1;min-height:130px;height:0;margin:0;border-color:#ffffff20;background:#18191b22}
    :host([data-overlay]) #panel-content{overflow-y:auto;overflow-x:hidden}
    :host([data-overlay]) #export-dialog{background:#18191bf2;text-shadow:none;pointer-events:auto}
    :host([data-overlay]) #export-dialog::backdrop{background:transparent}
    @media(prefers-reduced-motion:reduce){:host([data-overlay]) #panel-content{transform:none;transition:opacity 125ms ease,visibility 0s 125ms}}
    figure{position:relative;display:flex;flex-direction:column;height:var(--card-height,292px);background:var(--bg);margin:0 0 20px;padding:12px 10px 8px;border:1px solid var(--line);border-radius:6px}
    figure:last-of-type{margin-bottom:0}figcaption{flex:none}
    figcaption{display:flex;align-items:center;gap:8px;padding:0 2px 4px;font-size:14px;font-weight:600}
    select,button{color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:4px;font:12px/1.4 inherit;cursor:pointer;padding:3px 6px}
    select{margin-left:auto;max-width:128px}button:focus-visible,select:focus-visible,[role=button]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    svg{display:block;width:100%;overflow:visible;flex:1;min-height:0}#density{cursor:crosshair;touch-action:pan-y}
    #cloud text{fill:var(--text);cursor:pointer}#cloud text.hot{fill:var(--live-ink)}#cloud text.warm{fill:var(--accent)}
    #cloud text:hover,#cloud text.selected{fill:var(--live-ink)}
    #cloud .term-count{fill:var(--muted);font-weight:400}#cloud text.selected{font-weight:700;text-decoration:underline}
    #cloud-note{display:none}
    #open-note{color:var(--accent);display:grid;place-items:center;width:28px;height:28px;padding:5px;margin-left:auto;text-decoration:none;border:1px solid var(--line);border-radius:4px}#open-note:hover{background:var(--fill)}
    #recent-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}#export-dialog #recent-tags button{padding:3px 7px;font-size:12px}.clip-summary{color:var(--muted);font-size:12px;margin:-10px 0 14px}
    .grid{stroke:var(--line);stroke-width:.7}.axis{fill:var(--muted);font-size:10px}
    .area{fill:var(--live-ink-soft)}.curve{stroke:var(--live-ink);fill:none;stroke-width:1.8}
    .peak{fill:var(--bg);stroke:var(--live-ink);stroke-width:1.5}
    .match{stroke:#eab66b;fill:none;stroke-width:2}.playhead{stroke:var(--text);stroke-dasharray:3 3;stroke-width:1}.hover{stroke:var(--muted);stroke-dasharray:2 3}
    .empty{position:absolute;inset:48px 12px 25px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--muted);font-size:13px;text-align:center}
    /* 加载态：呼吸点 + 阶段叙事。用 --live 专属色，不改 --accent，避免影响任何控件配色。 */
    .load{display:none;flex-direction:column;align-items:center;gap:12px}
    .empty[data-load=on]{gap:0;background:radial-gradient(58% 46% at 50% 50%,var(--live-soft),transparent 72%)}
    .empty[data-load=on] .load{display:flex}
    .load-pulse{display:flex;align-items:center;gap:6px;height:8px}
    .load-pulse i{display:block;width:5px;height:5px;border-radius:50%;background:var(--live);opacity:.25;animation:bili-pulse 1.7s ease-in-out infinite}
    .load-pulse i:nth-child(2){width:8px;height:8px;animation-delay:.18s}
    .load-pulse i:nth-child(3){animation-delay:.36s}
    @keyframes bili-pulse{0%,100%{opacity:.22;transform:scale(.82)}50%{opacity:1;transform:scale(1.12)}}
    .load-rail{width:78px;height:1px;background:linear-gradient(90deg,transparent,var(--live),transparent);animation:bili-rail 1.7s ease-in-out infinite}
    @keyframes bili-rail{0%,100%{transform:scaleX(.25);opacity:.35}50%{transform:scaleX(1);opacity:1}}
    .load-phase{color:var(--muted);font-size:12px;line-height:17px;min-height:17px}
    .load-phase.phase-in{animation:bili-phase .34s ease-out}
    @keyframes bili-phase{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
    figure.settle{animation:bili-settle .62s ease-out}
    @keyframes bili-settle{0%{border-color:var(--live)}100%{border-color:var(--line)}}
    /* 落地衔接：骨架先淡出，真内容再错峰入场，避免「啪」地一下换掉。 */
    .empty.leaving{opacity:0;transition:opacity .3s ease}
    #cloud.enter text{animation:word-in .42s cubic-bezier(.2,1.15,.35,1) backwards}
    @keyframes word-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    #density .curve.enter{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:curve-in .82s cubic-bezier(.32,.9,.32,1) forwards}
    @keyframes curve-in{to{stroke-dashoffset:0}}
    #density .area.enter{animation:area-in .62s ease .1s backwards}
    @keyframes area-in{from{opacity:0}to{opacity:1}}
    #density .peak.enter{animation:peak-in .3s ease backwards}
    @keyframes peak-in{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}
    #density .peak{transform-box:fill-box;transform-origin:center}
    @media (prefers-reduced-motion:reduce){
      .load-pulse i,.load-rail,.load-phase.phase-in,figure.settle{animation:none}
      .load-pulse i{opacity:.55}
      .empty.leaving{transition:none}
      #cloud.enter text,#density .curve.enter,#density .area.enter,#density .peak.enter{animation:none;stroke-dashoffset:0}
    }
    .timeline-info{position:absolute;left:2px;right:2px;bottom:calc(100% + 6px);display:flex;align-items:flex-end;justify-content:center;z-index:2;pointer-events:none}
    #tooltip{max-width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);box-shadow:0 6px 20px var(--shadow);color:var(--text);font-size:12px;line-height:18px;overflow-wrap:anywhere;pointer-events:none}
    #tooltip .detail-title{font-weight:600;font-variant-numeric:tabular-nums;margin-bottom:2px}
    #tooltip .detail-sample{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    #status{position:absolute;bottom:12px;left:12px;right:12px;font-size:11px;color:var(--muted);pointer-events:none;background:var(--bg)}
    #status[data-error=true]{color:#df7180}#clear{margin-left:auto}#mode{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}#mode button{font-size:11px;padding:4px 6px;white-space:nowrap}#mode button[aria-pressed=true]{color:var(--accent);border-color:var(--accent);background:var(--fill)}
    #timeline #status{position:static;flex:none;min-height:0;margin-top:3px;line-height:1.4;pointer-events:auto}
    #timeline #open-note{display:flex;align-items:center;gap:5px;width:auto;height:28px;flex:none;margin:0;padding:4px 7px;white-space:nowrap;font-size:12px;line-height:18px}#open-note svg{width:14px;height:14px;flex:none}
    .clip-controls{display:flex;align-items:center;gap:6px;flex:none;margin-top:6px}
    .time-field{display:flex;align-items:center;flex:1;min-width:0;height:32px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--muted);font-size:12px}
    .time-field input{width:100%;min-width:0;height:30px;border:0;border-radius:3px;background:transparent;color:var(--text);font:13px/1.4 inherit;font-variant-numeric:tabular-nums;text-align:center}
    .clip-jump{display:grid;place-items:center;flex:none;width:28px;height:30px;padding:5px;border:0;background:transparent;color:var(--accent)}
    .clip-jump svg{width:18px;height:18px}.clip-jump:hover:not(:disabled){background:var(--fill)}
    #clip-duration{flex:none;max-width:100px;text-align:center;font-size:12px;line-height:1.3;color:var(--muted);font-variant-numeric:tabular-nums}
    input:focus-visible,.range-window:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .range-handle:focus{outline:none}
    .range-handle:focus-visible::after{outline:2px solid var(--accent);outline-offset:2px}
    input[aria-invalid=true],.time-field:has(input[aria-invalid=true]){border-color:#df7180}button:disabled,input:disabled{opacity:.45;cursor:not-allowed}
    #save-clip{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:8px;color:var(--accent)}
    #save-clip svg{width:18px;height:18px;flex:none}#save-clip:hover:not(:disabled){background:var(--fill)}
    #seek-status{position:absolute;top:0;right:3.75%;max-width:58%;font-size:11px;line-height:1.4;color:var(--muted);text-align:right;pointer-events:none}
    .density-wrap{position:relative;flex:1;min-height:0}.density-wrap #density{width:100%;height:100%}
    #export-dialog{width:min(380px,calc(100vw - 32px));padding:22px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font:14px/1.5 inherit;box-shadow:0 16px 50px #0004}
    #export-dialog::backdrop{background:#0007}#export-dialog h2{margin:0 0 18px;font-size:18px}
    #export-dialog label{display:block;margin-top:14px}#export-dialog small{color:var(--muted);font-size:12px}
    #export-dialog input,#export-dialog textarea,#export-dialog select{display:block;width:100%;margin-top:6px;padding:9px 10px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--text);font:inherit}
    #export-dialog select{max-width:none;margin-left:0}
    #export-dialog{max-height:calc(100vh - 32px);overflow:auto}
    #export-dialog .path-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px}#export-dialog .path-heading label{margin:0}
    #export-dialog .path-default{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}#export-dialog .path-default input{width:auto;margin:0;padding:0;accent-color:var(--accent)}
    #export-path-options{max-height:132px;overflow:auto;margin-top:4px;border:1px solid var(--line);border-radius:5px}#export-path-options[hidden]{display:none}
    #export-dialog #export-path-options button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:0;overflow-wrap:anywhere}#export-path-options button[aria-selected=true]{background:var(--fill);color:var(--accent)}
    #export-dialog textarea{resize:vertical;min-height:80px}#export-dialog .dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
    #export-transfer{flex:none;margin-top:5px}#export-transfer[hidden]{display:none}#export-transfer progress{display:block;width:100%;height:5px;accent-color:var(--accent)}.transfer-row{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--muted)}#transfer-detail{flex:1;min-width:0}#export-transfer button{padding:4px 8px;min-height:28px;font-size:12px}
    #export-dialog button{padding:8px 16px}#export-confirm{color:var(--accent);border-color:var(--accent);background:var(--fill)}
    #watch-track{position:absolute;left:10%;right:3.75%;height:12px;pointer-events:none;z-index:1}
    .watch-segment{position:absolute;top:0;height:12px;min-width:3px;pointer-events:auto;outline:none;cursor:help}
    .watch-segment::after{content:'';position:absolute;left:0;right:0;top:5px;height:2px;border-radius:2px;background:var(--accent);opacity:.55}
    .watch-segment:hover::after,.watch-segment:focus-visible::after{height:3px;opacity:1}
    #watch-start{position:absolute;top:3px;width:6px;height:6px;transform:translateX(-50%);border-radius:50%;background:var(--accent);opacity:.65;pointer-events:none}
    #range-track{position:absolute;left:10%;right:3.75%;pointer-events:none}
    .range-window{position:absolute;top:0;bottom:0;cursor:grab;touch-action:none;pointer-events:auto}
    .range-window:active{cursor:grabbing}
    .range-handle{position:absolute;top:0;bottom:0;width:24px;transform:translateX(-50%);cursor:ew-resize;touch-action:none;pointer-events:auto}
    .range-handle::after{content:'';position:absolute;left:9px;top:50%;transform:translateY(-50%);height:24px;width:6px;border:1px solid var(--accent);border-radius:2px;background:var(--bg)}
    .clip-highlight{fill:var(--fill);pointer-events:none}.clip-edge{stroke:var(--accent);stroke-width:1;pointer-events:none}
  `;

  function svgNode(tag, attributes = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // Pointer x -> video time, matching the 32..308 plot area drawn by drawDensity.
  function densityTime(clientX) {
    const rect = ui.density.getBoundingClientRect();
    return Math.max(0, Math.min(videoDuration, ((clientX - rect.left) / rect.width * 320 - 32) / 276 * videoDuration));
  }
  // Keep in sync with @version above (the value is substituted by the test suite's guard test).
  const SCRIPT_VERSION = '0.3.48';
  function createPanel() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.version = SCRIPT_VERSION;
    // Bilibili / other scripts can disable hit testing on the whole right rail.
    // Override inheritance only on our panel, never re-enable native controls.
    host.style.setProperty('pointer-events', 'auto', 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.addEventListener('click', () => { diagnostic.clicks++; }, { capture: true, passive: true });
    shadow.addEventListener('pointermove', () => { diagnostic.moves++; }, { capture: true, passive: true });
    shadow.innerHTML = `<style>${styles}</style><button id="edge-trigger" type="button" aria-label="展开 Bili-Peek 工具栏" aria-expanded="false" aria-controls="panel-content"></button><div id="panel-content">
      <figure aria-label="弹幕词云"><figcaption id="cloud-caption">弹幕词云<button id="clear" hidden title="清除词语筛选">清除</button><button id="overlay-pin" type="button" aria-label="固定展开" title="固定展开" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m8 3 8 0-1 7 4 4H5l4-4-1-7ZM12 14v7"/></svg></button><div id="mode" role="group" aria-label="词云模式"><button id="mode-words" type="button" aria-pressed="true" title="按词语出现的弹幕条数排序">高频词</button><button id="mode-phrases" type="button" aria-pressed="false" title="查看重复出现的短语">重复短语</button></div></figcaption>
        <div id="cloud-note"></div><svg id="cloud" viewBox="0 0 320 230" role="group" aria-label="点击词语查看出现时段"></svg><div id="cloud-empty" class="empty">正在加载弹幕…</div></figure>
      <figure id="timeline" aria-label="弹幕密度图"><div class="timeline-info"><div id="tooltip" hidden></div></div>
        <div class="density-wrap"><div id="watch-track" aria-label="已观看区间" hidden></div><span id="watch-start" hidden></span><span id="seek-status" role="status" aria-live="polite"></span><svg id="density" viewBox="0 0 320 220" preserveAspectRatio="none" role="button" tabindex="0" aria-label="弹幕密度，点击位置跳转，左右键选择时间，回车跳转"></svg>
        <div id="range-track" aria-label="在密度图中拖动选择截取时段"><div id="range-window" class="range-window" tabindex="0" role="group" aria-label="移动整个选区，左右键平移"></div><div id="range-start" class="range-handle" tabindex="0" role="slider" aria-label="截取起点" aria-orientation="horizontal"></div><div id="range-end" class="range-handle" tabindex="0" role="slider" aria-label="截取终点" aria-orientation="horizontal"></div></div></div>
        <div class="clip-controls"><div class="time-field"><button id="jump-start" class="clip-jump" type="button" aria-label="跳转到填写的开始时间" title="跳转到开始时间" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0Z"/><circle cx="12" cy="9" r="2.5"/><path d="M5 18c-2 1-3 2-3 3 0 2 4.5 3 10 3s10-1 10-3c0-1-1-2-3-3" transform="translate(2 2) scale(.8333)"/></svg></button><input id="clip-start" type="text" inputmode="numeric" aria-label="截取开始时间" aria-describedby="status" placeholder="00:00" title="分:秒或时:分:秒" disabled></div><output id="clip-duration" aria-label="截取总时长" title="截取总时长">—</output><div class="time-field"><input id="clip-end" type="text" inputmode="numeric" aria-label="截取结束时间" aria-describedby="status" placeholder="00:00" title="分:秒或时:分:秒" disabled><button id="jump-end" class="clip-jump" type="button" aria-label="跳转到填写的结束时间" title="跳转到结束时间" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0Z"/><circle cx="12" cy="9" r="2.5"/><path d="M5 18c-2 1-3 2-3 3 0 2 4.5 3 10 3s10-1 10-3c0-1-1-2-3-3" transform="translate(2 2) scale(.8333)"/></svg></button></div><button id="save-clip" type="button" aria-label="保存选区草稿" title="保存选区草稿（尚未接通音视频导出）" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></svg></button></div>
        <div id="density-empty" class="empty">正在加载弹幕…</div><div id="export-transfer" hidden><progress id="transfer-progress" max="100" aria-label="当前保存阶段进度"></progress><div class="transfer-row"><span id="transfer-detail"></span><a id="open-note" hidden aria-label="打开保存的 Obsidian 笔记" title="打开笔记"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/></svg><span>打开笔记</span></a><button id="transfer-pause" type="button" hidden>暂停</button><button id="transfer-cancel" type="button">取消</button></div></div><div id="status" role="status" aria-live="polite"></div></figure></div>`;
    ui = Object.fromEntries(['cloud', 'cloud-caption', 'cloud-note', 'mode', 'mode-words', 'mode-phrases', 'clear', 'density', 'cloud-empty', 'density-empty', 'tooltip', 'timeline', 'status', 'open-note', 'range-track', 'range-window', 'range-start', 'range-end', 'clip-start', 'clip-end', 'clip-duration', 'watch-track', 'watch-start', 'seek-status', 'jump-start', 'jump-end', 'save-clip'].map(id => [id, shadow.getElementById(id)]));
    const content = shadow.getElementById('panel-content');
    const edge = shadow.getElementById('edge-trigger');
    const pin = shadow.getElementById('overlay-pin');
    const expand = () => { if (host.hasAttribute('data-overlay')) setOverlayExpanded(true); };
    edge.addEventListener('pointerenter', () => { if (matchMedia('(hover:hover) and (pointer:fine)').matches) expand(); });
    edge.addEventListener('click', expand);
    edge.addEventListener('focus', expand);
    content.addEventListener('pointerenter', expand);
    for (const node of [edge, content]) node.addEventListener('pointerleave', queueOverlayClose);
    shadow.addEventListener('focusin', expand);
    shadow.addEventListener('focusout', queueOverlayClose);
    shadow.addEventListener('pointerup', queueOverlayClose);
    shadow.addEventListener('lostpointercapture', queueOverlayClose);
    pin.addEventListener('click', () => {
      const pinned = pin.getAttribute('aria-pressed') !== 'true';
      pin.setAttribute('aria-pressed', String(pinned));
      pin.title = pinned ? '解除固定展开' : '固定展开';
      pin.setAttribute('aria-label', pin.title);
      setOverlayExpanded(true); queueOverlayClose();
    });
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'wheel']) {
      shadow.addEventListener(type, event => { if (host.hasAttribute('data-overlay')) event.stopPropagation(); });
    }
    for (const id of ['export-transfer', 'transfer-progress', 'transfer-detail', 'transfer-pause', 'transfer-cancel']) ui[id] = shadow.getElementById(id);
    bindClipControls();
    for (const [id, phrases] of [['mode-words', false], ['mode-phrases', true]]) {
      ui[id].addEventListener('click', () => {
        phraseMode = phrases; selectedTerm = '';
        ui['mode-words'].setAttribute('aria-pressed', String(!phrases));
        ui['mode-phrases'].setAttribute('aria-pressed', String(phrases));
        if (chartData) renderCharts();
      });
    }
    ui.clear.addEventListener('click', () => { selectedTerm = ''; renderCharts(); });
    ui.density.addEventListener('pointermove', event => showTooltip(densityTime(event.clientX)));
    ui.density.addEventListener('pointerleave', () => { ui.tooltip.hidden = true; ui.density.querySelector('.hover')?.setAttribute('visibility', 'hidden'); });
    ui.density.addEventListener('click', event => {
      if (!chartData) return;
      const rect = ui.density.getBoundingClientRect();
      const y = (event.clientY - rect.top) / rect.height * chartData.height;
      if (y < 18 || y > chartData.bottom) return;
      jump(densityTime(event.clientX));
    });
    ui.density.addEventListener('keydown', event => {
      if (!chartData) return;
      if (['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) event.preventDefault();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') showTooltip(Math.max(0, Math.min(videoDuration, hoverTime + (event.key === 'ArrowLeft' ? -1 : 1) * chartData.width)));
      if (event.key === 'Enter') jump(hoverTime);
    });
  }

  function parseClipTime(value) {
    const parts = value.trim().split(':');
    if (parts.length > 3 || !parts.every(part => /^\d+$/.test(part))) return NaN;
    if (parts.length > 1 && Number(parts.at(-1)) >= 60) return NaN;
    if (parts.length === 3 && Number(parts[1]) >= 60) return NaN;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  function showTransfer(route, patch) {
    const state = { ...transferStates.get(route), ...patch };
    transferStates.set(route, state);
    if (transferStates.size > 100) { const ended = [...transferStates.keys()].find(key => !exportingRoutes.has(key) && key !== currentRoute); if (ended) transferStates.delete(ended); }
    if (route !== currentRoute || !ui) return;
    ui['export-transfer'].hidden = false;
    ui['transfer-progress'].value = state.value || 0;
    ui['transfer-progress'].setAttribute('aria-label', '整体保存进度');
    ui['transfer-detail'].textContent = state.text || '';
    ui['transfer-detail'].style.color = state.error ? 'var(--danger, #ef6674)' : '';
    ui['transfer-pause'].hidden = !state.canPause;
    ui['transfer-pause'].textContent = state.paused ? '继续' : '暂停';
    ui['transfer-pause'].onclick = state.pause || null;
    ui['transfer-cancel'].hidden = Boolean(state.finished);
    ui['transfer-cancel'].disabled = !state.cancel || Boolean(state.cannotCancel);
    ui['transfer-cancel'].onclick = state.cancel || null;
    renderNoteLink();
  }

  function renderNoteLink() {
    if (!ui) return;
    const note = latestNotes.get(currentRoute?.split(':')[0]);
    const valid = typeof note?.uri === 'string' && /^obsidian:\/\/open\?path=/.test(note.uri);
    ui['open-note'].hidden = !valid;
    if (valid) { ui['open-note'].href = note.uri; ui['open-note'].title = '打开最新保存的笔记' + (note.filename ? '：' + note.filename : ''); }
  }
  function rememberNote(route, result) {
    if (typeof result.obsidianUri !== 'string' || !/^obsidian:\/\/open\?path=/.test(result.obsidianUri)) return;
    const stored = savedValue('latest-export-notes', {});
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const [id, entry] of Object.entries(stored)) {
      if (typeof entry?.uri === 'string' && /^obsidian:\/\/open\?path=/.test(entry.uri) && Number.isFinite(entry.at) && entry.at > (latestNotes.get(id)?.at || 0)) latestNotes.set(id, entry);
    }
    const video = route.split(':')[0], at = result.completedAt || Date.now();
    if ((latestNotes.get(video)?.at || 0) > at) return;
    latestNotes.delete(video); latestNotes.set(video, { uri: result.obsidianUri, filename: result.filename, at });
    if (latestNotes.size > 200) latestNotes.delete(latestNotes.keys().next().value);
    try { GM_setValue('latest-export-notes', Object.fromEntries(latestNotes)); } catch (error) { console.error('Bili-Peek: 笔记跳转记录未持久化', error); }
    renderNoteLink();
  }

  function updateClipUI(syncInputs = true) {
    const enabled = Boolean(chartData && clipRange && videoDuration >= 1 && currentRoute === routeKey(location.href));
    for (const id of ['clip-start', 'clip-end', 'save-clip']) ui[id].disabled = !enabled || (id === 'save-clip' && exportingRoutes.has(currentRoute));
    ui['save-clip'].setAttribute('aria-busy', String(exportingRoutes.has(currentRoute)));
    if (transferStates.has(currentRoute)) showTransfer(currentRoute, {});
    else if (latestNotes.has(currentRoute?.split(':')[0])) showTransfer(currentRoute, { value: 100, text: '已保存笔记，可打开最新一段。', finished: true, canPause: false });
    else ui['export-transfer'].hidden = true;
    renderNoteLink();
    ui['range-track'].hidden = !enabled;
    if (!enabled) { ui['seek-status'].textContent = ''; ui['clip-duration'].textContent = '—'; ui['jump-start'].disabled = true; ui['jump-end'].disabled = true; return; }
    ui['range-track'].style.top = 22 / chartData.height * 100 + '%';
    ui['range-track'].style.bottom = 24 / chartData.height * 100 + '%';
    const { start, end } = clipRange;
    const left = start / videoDuration * 100, right = end / videoDuration * 100;
    ui['range-window'].style.left = left + '%';
    ui['range-window'].style.width = (right - left) + '%';
    ui['range-window'].setAttribute('aria-label', `选区 ${formatTime(start)} 至 ${formatTime(end)}，左右键平移`);
    for (const [id, value, min, max] of [['range-start', start, 0, end - 1], ['range-end', end, start + 1, Math.floor(videoDuration)]]) {
      const node = ui[id]; node.style.left = value / videoDuration * 100 + '%';
      node.setAttribute('aria-valuemin', min); node.setAttribute('aria-valuemax', max);
      node.setAttribute('aria-valuenow', value); node.setAttribute('aria-valuetext', formatTime(value));
    }
    if (syncInputs) {
      ui['clip-start'].value = formatTime(start); ui['clip-end'].value = formatTime(end);
      for (const id of ['clip-start', 'clip-end']) ui[id].removeAttribute('aria-invalid');
    }
    updateClipDuration();
    const x1 = 32 + start / videoDuration * 276, x2 = 32 + end / videoDuration * 276;
    const highlight = ui.density.querySelector('.clip-highlight');
    highlight?.setAttribute('x', x1); highlight?.setAttribute('width', x2 - x1);
    for (const [index, edge] of [...ui.density.querySelectorAll('.clip-edge')].entries()) {
      edge.setAttribute('x1', index ? x2 : x1); edge.setAttribute('x2', index ? x2 : x1);
    }
  }

  function updateClipDuration() {
    const start = parseClipTime(ui['clip-start'].value), end = parseClipTime(ui['clip-end'].value);
    const ready = Boolean(chartData && clipRange && currentRoute === routeKey(location.href));
    const startValid = ready && Number.isFinite(start) && start >= 0 && start <= Math.floor(videoDuration);
    const endValid = ready && Number.isFinite(end) && end >= 0 && end <= Math.floor(videoDuration);
    ui['jump-start'].disabled = !startValid; ui['jump-end'].disabled = !endValid;
    const total = end - start;
    ui['clip-duration'].textContent = startValid && endValid && total > 0
      ? [total >= 3600 ? `${Math.floor(total / 3600)} 时` : '', total >= 60 ? `${Math.floor(total / 60) % 60} 分` : '', `${total % 60} 秒`].filter(Boolean).join(' ')
      : '—';
  }

  function commitClipInputs() {
    if (!clipRange || !chartData) return false;
    const start = parseClipTime(ui['clip-start'].value), end = parseClipTime(ui['clip-end'].value);
    const startValid = Number.isFinite(start) && start >= 0 && start < Math.floor(videoDuration);
    const endValid = Number.isFinite(end) && end <= Math.floor(videoDuration) && end > start;
    ui['clip-start'].setAttribute('aria-invalid', String(!startValid));
    ui['clip-end'].setAttribute('aria-invalid', String(!endValid));
    ui['save-clip'].disabled = !startValid || !endValid || exportingRoutes.has(currentRoute);
    updateClipDuration();
    if (!startValid || !endValid) { status(`请输入有效起止时间（分:秒或时:分:秒），结束须晚于开始且不超过 ${formatTime(videoDuration)}。`, true); return false; }
    clipRange = { start, end }; updateClipUI(); status(''); return true;
  }

  function moveClip(kind, delta, base = clipRange) {
    if (!base) return;
    const limit = Math.floor(videoDuration);
    if (kind === 'range-start') clipRange = { start: Math.max(0, Math.min(base.end - 1, base.start + delta)), end: base.end };
    else if (kind === 'range-end') clipRange = { start: base.start, end: Math.min(limit, Math.max(base.start + 1, base.end + delta)) };
    else {
      delta = Math.max(-base.start, Math.min(limit - base.end, delta));
      clipRange = { start: base.start + delta, end: base.end + delta };
    }
    updateClipUI(); status('');
  }

  function bindClipControls() {
    for (const [button, input] of [['jump-start', 'clip-start'], ['jump-end', 'clip-end']]) {
      ui[button].addEventListener('click', () => {
        updateClipDuration();
        if (!ui[button].disabled) jump(parseClipTime(ui[input].value));
      });
    }
    for (const id of ['clip-start', 'clip-end']) {
      ui[id].parentElement.addEventListener('wheel', event => {
        if (event.ctrlKey || !event.deltaY || ui[id].disabled || currentRoute !== routeKey(location.href)) return;
        event.preventDefault();
        if (!commitClipInputs()) return;
        moveClip(id === 'clip-start' ? 'range-start' : 'range-end', event.deltaY < 0 ? 1 : -1);
      }, { passive: false });
      ui[id].title = '分:秒或时:分:秒；滚轮向上加 1 秒，向下减 1 秒';
      ui[id].addEventListener('change', commitClipInputs);
      ui[id].addEventListener('input', () => { ui['save-clip'].disabled = true; updateClipDuration(); });
      ui[id].addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commitClipInputs(); }
        if (event.key === 'Escape') { updateClipUI(); status(''); }
      });
    }
    for (const id of ['range-start', 'range-end', 'range-window']) {
      const node = ui[id];
      node.addEventListener('pointerdown', event => {
        if (!clipRange || !chartData || event.button !== 0 || rangeDrag) return;
        event.preventDefault(); node.focus();
        rangeDrag = { id, pointer: event.pointerId, x: event.clientX, moved: false, base: { ...clipRange }, width: ui['range-track'].getBoundingClientRect().width, route: currentRoute };
        node.setPointerCapture(event.pointerId); ui.tooltip.hidden = true;
      });
      node.addEventListener('pointermove', event => {
        if (!rangeDrag || rangeDrag.pointer !== event.pointerId || rangeDrag.id !== id || rangeDrag.route !== currentRoute || !chartData) return;
        if (Math.abs(event.clientX - rangeDrag.x) > 3) rangeDrag.moved = true;
        if (rangeDrag.moved) moveClip(id, Math.round((event.clientX - rangeDrag.x) / Math.max(1, rangeDrag.width) * videoDuration), rangeDrag.base);
      });
      const finish = event => {
        if (rangeDrag?.pointer !== event.pointerId || rangeDrag.id !== id) return;
        const drag = rangeDrag; rangeDrag = null;
        if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
        if (event.type === 'pointerup' && id === 'range-window' && !drag.moved && drag.route === currentRoute && chartData) jump(densityTime(event.clientX));
      };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, finish);
      node.addEventListener('pointermove', event => { if (!rangeDrag) showTooltip(densityTime(event.clientX)); });
      node.addEventListener('pointerleave', () => { ui.tooltip.hidden = true; ui.density.querySelector('.hover')?.setAttribute('visibility', 'hidden'); });
      node.addEventListener('keydown', event => {
        if (!chartData || !clipRange) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); moveClip(id, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
        }
      });
    }
    ui['save-clip'].title = '保存视频片段和字幕到 Obsidian';
    ui['save-clip'].setAttribute('aria-label', '保存视频片段和字幕到 Obsidian');
    ui['save-clip'].addEventListener('click', async () => {
      if (exportingRoutes.has(currentRoute)) return;
      if (currentRoute !== routeKey(location.href) || !commitClipInputs()) return;
      const taskRoute = currentRoute, range = { ...clipRange };
      exportingRoutes.add(taskRoute); updateClipUI();
      try {
        const draftKey = `${taskRoute}:${range.start}:${range.end}`;
        const token = savedValue('export-token', '');
        let exportMedia;
        status('');
        const metadata = await askExportMetadata(draftKey, range, token ? async () => {
          const health = await helperRequest('/health', token, undefined, 2000);
          if (!health?.ready) throw new Error('助手尚未就绪，请检查 CPod 运行状态后重试');
          exportMedia = await loadExportMedia(taskRoute, token);
          return { segmentAvailable: Boolean(health.segmentAvailable), qualities: exportMedia.qualities, title: exportMedia.info.data.title };
        } : null, token ? () => helperRequest('/folders', token) : null);
        if (!metadata) return;
        if (taskRoute !== currentRoute || taskRoute !== routeKey(location.href)) { status('视频已切换，请重新选择片段后保存。', true); return; }
        if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') throw new Error('请在油猴中更新脚本权限后保存。');
        if (token) {
          updateClipUI();
          let overall = 0;
          const report = (message, error = false, finished = false) => {
            showTransfer(taskRoute, { value: overall, text: message, error, canPause: false, finished, cannotCancel: true });
            if (currentRoute === taskRoute) status('');
          };
          report('正在连接本地助手…');
          await helperRequest('/health', token, undefined, 2000);
          report('正在读取当前分 P 的视频和字幕…');
          const payload = await prepareExport(taskRoute, range, token, metadata.downloadQuality, exportMedia);
          Object.assign(payload, metadata);
          const job = await helperRequest('/clips', token, payload);
          let paused = false;
          const action = async (name, button) => {
            button.disabled = true;
            try { const changed = await helperRequest(`/jobs/${job.key}/${name}`, token, {}); paused = changed.paused; }
            catch (error) { report(error.message, true); }
            finally { button.disabled = false; }
          };
          report('任务已提交，正在准备保存…');
          while (true) {
            const result = await helperRequest(`/jobs/${job.key}`, token);
            if (result.state === 'complete') {
              overall = 100;
              report(result.recognition?.state === 'complete' ? '视频和 Buzz 识别稿已保存，原视频无字幕。' : result.recognition?.state === 'failed' ? `视频和笔记已保存；Buzz 识别未完成：${String(result.recognition.error || '请重试').slice(-200)}` : result.hasSubtitles === false ? '视频和笔记已保存到 Obsidian，未保存字幕。' : '视频、字幕和笔记已保存到 Obsidian。', false, true);
              exportDrafts.delete(draftKey);
              rememberNote(taskRoute, result);
              if (result.defaultDirectoryError && currentRoute === taskRoute) status('笔记已保存，但默认路径未更新：' + result.defaultDirectoryError, true);
              return;
            }
            if (result.state === 'failed') throw new Error(result.error);
            if (result.state === 'cancelled') { report(metadata.downloadEngine === 'nre' ? '保存已取消；下载缓存已保留，可重试。' : '保存已取消，可重试。', false, true); return; }
            if (result.state === 'missing') throw new Error('助手已重启，任务状态丢失，请重试');
            if (result.stage) {
              const label = { queued: `等待保存${result.queuePosition ? ` · 第 ${result.queuePosition} 个` : ''}`, prepare: '准备保存', source: '选择下载来源', download: '下载视频', media: metadata.downloadEngine === 'nre' ? '裁剪视频' : '下载并裁剪', probe: '检查时长', verify: '检查完整性', transcribe: 'Buzz 语音识别', write: '写入 Obsidian', complete: '完成保存' }[result.stage] || '保存中';
              paused = Boolean(result.paused);
                overall = overallProgress(result.stage, result.percent, metadata.downloadEngine === 'nre', overall);
                const size = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
                let text = result.stage === 'download' && Number.isFinite(result.totalBytes)
                  ? `${paused ? '已暂停' : '下载'} · ${size(result.downloadedBytes)} / ${size(result.totalBytes)} · ${size(result.bytesPerSecond || 0)}/s${Number.isFinite(result.etaSeconds) ? ` · 约 ${result.etaSeconds} 秒` : ''}`
                  : label;
                text += `${Number.isFinite(result.elapsedSeconds) ? ` · 已用 ${result.elapsedSeconds} 秒` : ''}`;
                showTransfer(taskRoute, { value: overall, text, canPause: result.canPause, paused, pause: () => action(paused ? 'resume' : 'pause', ui['transfer-pause']), cancel: () => action('cancel', ui['transfer-cancel']), cannotCancel: result.stage === 'write' || result.stage === 'complete', finished: false });
            }
            await new Promise(resolve => setTimeout(resolve, 1200));
          }
        }
        status(`选区 ${formatTime(range.start)}–${formatTime(range.end)} 已保存为本地草稿；请先用油猴菜单配对本地助手，尚未导出视频。`);
      } catch (error) {
        if (transferStates.has(taskRoute)) {
          showTransfer(taskRoute, { text: `保存失败：${error.message}`, error: true, finished: true, canPause: false });
          if (currentRoute === taskRoute) status('');
        } else if (currentRoute === taskRoute) status(`保存失败：${error.message}`, true);
      }
      finally { exportingRoutes.delete(taskRoute); updateClipUI(); }
    });
    updateClipUI();
  }

  function askExportMetadata(draftKey, range, loadMedia = null, loadFolders = null) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.id = 'export-dialog';
      dialog.innerHTML = `<form><h2>保存片段</h2><label>笔记名称<input id="export-name" maxlength="80" required></label><label>标签 <small>必填，用逗号分隔</small><input id="export-tags" placeholder="例如：学习/编程，待整理" required></label><label>摘要 <small>选填</small><textarea id="export-summary" maxlength="2000" placeholder="简单描述这段内容，也可以留空"></textarea></label><div class="dialog-actions"><button id="export-cancel" type="button">取消</button><button id="export-confirm" type="submit">保存</button></div></form>`;
      const name = dialog.querySelector('#export-name'), tags = dialog.querySelector('#export-tags');
      name.value = document.title.replace(/[_-]哔哩哔哩.*$/, '').trim().slice(0, 80) || '视频片段';
      let nameEdited = false;
      name.addEventListener('input', () => { nameEdited = true; });
      const summary = dialog.querySelector('#export-summary');
      const qualityLabel = document.createElement('label'); qualityLabel.textContent = '下载画质';
      const quality = document.createElement('select'); quality.id = 'export-quality'; qualityLabel.append(quality);
      const option = document.createElement('option'); option.textContent = loadMedia ? '正在读取可下载画质…' : '连接助手后读取'; quality.append(option); quality.disabled = true;
      const confirm = dialog.querySelector('#export-confirm'); confirm.disabled = Boolean(loadMedia);
      const qualityStatus = document.createElement('small'); qualityStatus.id = 'export-quality-status'; qualityStatus.setAttribute('role', 'status'); qualityLabel.append(qualityStatus);
      const retry = document.createElement('button'); retry.id = 'export-quality-retry'; retry.type = 'button'; retry.textContent = '重试读取画质'; retry.hidden = true; qualityLabel.append(retry);
      let mediaReady = !loadMedia, segmentAvailable = false;
      const refreshQuality = async () => {
        retry.hidden = true; qualityStatus.textContent = '正在读取可下载画质…';
        try {
          const result = await loadMedia();
          if (!dialog.isConnected) return;
          if (!nameEdited && typeof result.title === 'string' && result.title.trim()) name.value = result.title.trim().slice(0, 80);
          quality.replaceChildren();
          for (const item of result.qualities) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.label; quality.append(option); }
          const savedQuality = exportDrafts.get(draftKey)?.downloadQuality;
          quality.value = String(result.qualities.some(item => item.id === savedQuality) ? savedQuality : defaultDownloadQuality(result.qualities));
          quality.disabled = false; mediaReady = true; confirm.disabled = !foldersReady; segmentAvailable = result.segmentAvailable;
          qualityStatus.textContent = '';
        } catch (error) {
          if (!dialog.isConnected) return;
          quality.children[0].textContent = '读取失败，请重试';
          qualityStatus.textContent = error.message; retry.hidden = false;
        }
      };
      retry.addEventListener('click', refreshQuality);
      name.parentElement.after(qualityLabel);
      const pathField = document.createElement('div');
      pathField.innerHTML = `<div class="path-heading"><label for="export-path">保存路径</label><label class="path-default"><input id="export-path-default" type="checkbox">设为默认</label></div><input id="export-path" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="export-path-options" aria-describedby="export-path-status" placeholder="搜索仓库内文件夹" autocomplete="off"><div id="export-path-options" role="listbox" hidden></div><small id="export-path-status" role="status"></small><button id="export-path-retry" type="button" hidden>重试读取路径</button>`;
      qualityLabel.after(pathField);
      const destination = pathField.querySelector('#export-path'), makeDefault = pathField.querySelector('#export-path-default');
      const pathOptions = pathField.querySelector('#export-path-options'), pathStatus = pathField.querySelector('#export-path-status'), pathRetry = pathField.querySelector('#export-path-retry');
      let foldersReady = !loadFolders, folders = [], matches = [], focusedPath = -1;
      destination.disabled = !loadFolders; makeDefault.disabled = !loadFolders;
      const choosePath = value => { destination.value = value; destination.setCustomValidity(''); pathOptions.hidden = true; destination.setAttribute('aria-expanded', 'false'); destination.removeAttribute('aria-activedescendant'); pathStatus.textContent = '路径相对于当前 Obsidian 仓库'; remember(); };
      const searchPaths = () => {
        if (!foldersReady || !loadFolders) return;
        destination.setCustomValidity(''); pathOptions.replaceChildren(); focusedPath = -1;
        destination.removeAttribute('aria-activedescendant');
        matches = folderMatches(folders, destination.value === '.' ? '' : destination.value);
        pathOptions.hidden = !matches.length; destination.setAttribute('aria-expanded', String(Boolean(matches.length)));
        pathStatus.textContent = matches.length ? '选择已有文件夹；支持关键词和缩写搜索' : '没有匹配的文件夹，请换一个关键词';
        for (const [index, value] of matches.entries()) {
          const button = document.createElement('button'); button.type = 'button'; button.id = 'export-path-option-' + index;
          button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false'); button.textContent = value === '.' ? '仓库根目录' : value;
          button.addEventListener('click', () => { destination.focus(); choosePath(value); }); pathOptions.append(button);
        }
      };
      destination.addEventListener('input', searchPaths); destination.addEventListener('focus', searchPaths);
      destination.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !pathOptions.hidden) { event.preventDefault(); event.stopPropagation(); choosePath(destination.value); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) {
          event.preventDefault(); pathOptions.hidden = false; destination.setAttribute('aria-expanded', 'true');
          focusedPath = (focusedPath + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
          [...pathOptions.children].forEach((button, index) => button.setAttribute('aria-selected', String(index === focusedPath)));
          destination.setAttribute('aria-activedescendant', 'export-path-option-' + focusedPath);
        }
        if (event.key === 'Enter' && !pathOptions.hidden && focusedPath >= 0) { event.preventDefault(); choosePath(matches[focusedPath]); }
      });
      const refreshFolders = async () => {
        foldersReady = false; confirm.disabled = true; destination.disabled = true; pathRetry.hidden = true; pathStatus.textContent = '正在读取仓库文件夹…';
        try {
          const result = await loadFolders();
          if (!dialog.isConnected) return;
          folders = result.folders; foldersReady = true; destination.disabled = false;
          destination.value = exportDrafts.get(draftKey)?.outputDirectory ?? result.defaultDirectory;
          pathStatus.textContent = '路径相对于当前 Obsidian 仓库'; confirm.disabled = !mediaReady;
        } catch (error) { if (dialog.isConnected) { pathStatus.textContent = error.message; pathRetry.hidden = false; } }
      };
      pathRetry.addEventListener('click', refreshFolders);
      if (!loadFolders) { pathStatus.textContent = '连接助手后选择仓库文件夹'; makeDefault.disabled = true; }
      const saved = exportDrafts.get(draftKey);
      if (saved) { nameEdited = saved.nameEdited ?? saved.noteName !== name.value; name.value = saved.noteName; tags.value = saved.tagText; summary.value = saved.summary; }
      if (saved) makeDefault.checked = Boolean(saved.setDefaultDirectory);
      const context = document.createElement('p'); context.className = 'clip-summary';
      context.textContent = `${formatTime(range.start)}–${formatTime(range.end)} · ${Math.round(range.end - range.start)} 秒`;
      dialog.querySelector('h2').after(context);
      const recent = document.createElement('div'); recent.id = 'recent-tags'; tags.after(recent);
      let recentTags = []; try { recentTags = GM_getValue('recent-export-tags', []); } catch {}
      if (Array.isArray(recentTags)) for (const tag of recentTags.filter(tag => typeof tag === 'string').slice(0, 12)) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = tag; button.title = '添加此标签';
        button.addEventListener('click', () => {
          const selected = tags.value.split(/[,，\s]+/).filter(Boolean);
          if (!selected.includes(tag)) tags.value = [...selected, tag].join('，');
          tags.setCustomValidity(''); tags.focus();
        }); recent.append(button);
      }
      const remember = () => exportDrafts.set(draftKey, { noteName: name.value, nameEdited, tagText: tags.value, summary: summary.value, outputDirectory: destination.disabled ? exportDrafts.get(draftKey)?.outputDirectory : destination.value, setDefaultDirectory: makeDefault.checked, downloadQuality: quality.disabled ? exportDrafts.get(draftKey)?.downloadQuality : Number(quality.value) });
      dialog.addEventListener('input', remember);
      const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.querySelector('#export-cancel').addEventListener('click', () => finish(null));
      tags.addEventListener('input', () => tags.setCustomValidity(''));
      dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        if (!mediaReady || !foldersReady) return;
        if (loadFolders && !folders.includes(destination.value)) { destination.setCustomValidity('请从匹配结果中选择已有文件夹'); destination.reportValidity(); return; }
        const parsed = [...new Set(tags.value.split(/[,，\s]+/).map(tag => tag.replace(/^#+/, '').trim()).filter(Boolean))];
        if (!parsed.length || parsed.length > 20 || parsed.some(tag => !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) || /^\d+$/.test(tag) || tag.length > 100)) {
          tags.setCustomValidity('请填写 1–20 个有效标签，可用中文、字母、数字、下划线、短横线和层级斜杠，不能只有数字。'); tags.reportValidity(); return;
        }
        remember();
        GM_setValue('recent-export-tags', [...new Set([...parsed, ...(Array.isArray(recentTags) ? recentTags : [])])].slice(0, 12));
        finish({ noteName: name.value.trim(), tags: parsed, summary: summary.value.trim(), ...(loadFolders ? { outputDirectory: destination.value, setDefaultDirectory: makeDefault.checked } : {}), ...(quality.disabled ? {} : { downloadQuality: Number(quality.value) }), ...(segmentAvailable ? { downloadEngine: 'nre' } : {}) });
      });
      host.shadowRoot.append(dialog); dialog.showModal(); name.focus(); name.select();
      if (loadMedia) refreshQuality();
      if (loadFolders) refreshFolders();
    });
  }

  function helperRequest(endpoint, token, payload, timeout = 15000, port = helperPort(), ticket) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: payload ? 'POST' : 'GET', url: `http://127.0.0.1:${port}${endpoint}`, headers: { 'X-Bili-Peek-Token': token, 'X-Bili-Peek-Client': 'userscript', ...(ticket ? { 'X-Bili-Peek-Ticket': ticket } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { data: JSON.stringify(payload) } : {}), timeout,
        onload: response => {
          try { const result = JSON.parse(response.responseText); if (response.status >= 400) throw new Error(result.error || '助手请求失败'); resolve(result); }
          catch (error) { reject(error); }
        }, onerror: () => reject(new Error('助手未启动，请在 CPod 点击运行；已保存的配对信息无需重新输入')), ontimeout: () => reject(new Error('本地助手响应超时，请检查 CPod 运行状态')) });
    });
  }

  async function syncHelper() {
    const sequence = ++helperSync;
    clearTimeout(helperTimer);
    if (pageSuspended) return;
    const token = savedValue('export-token', '');
    const previous = helperOnline;
    let online = false, failed = false;
    if (managed() && token) {
      try { online = Boolean((await helperRequest('/health', token, undefined, 250)).ready); }
      catch { failed = true; }
    }
    if (pageSuspended || sequence !== helperSync) return;
    if (failed) { if (++helperFailures >= 2) helperOnline = false; }
    else { helperOnline = online; helperFailures = 0; }
    if (previous !== helperOnline || helperManaged !== managed()) schedule(0);
    helperManaged = managed();
    helperTimer = setTimeout(syncHelper, failed && helperOnline ? 50 : 250);
  }

  async function connectFromCPod() {
    const params = new URLSearchParams(location.hash.slice(1));
    const ticket = params.get('bili-peek-connect'), port = Number(params.get('port'));
    if (!ticket) return;
    // Remove the short-lived ticket before making any request or displaying it.
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!/^[a-f0-9]{64}$/.test(ticket) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    try {
      const result = await helperRequest('/pair', '', {}, 2000, port, ticket);
      if (!/^[a-f0-9]{64}$/.test(result.token) || result.port !== port) throw new Error('助手连接响应无效');
      GM_setValue('export-token', result.token); GM_setValue('export-port', port);
      helperOnline = true; schedule();
      connectionNotice('Bili-Peek 已连接 CPod，无需重复配对。');
    } catch (error) { connectionNotice(`Bili-Peek 连接失败：${error.message}`); }
  }

  function connectionNotice(message) {
    const notice = document.createElement('div'); notice.setAttribute('role', 'status'); notice.textContent = message;
    notice.style.cssText = 'position:fixed;top:80px;right:24px;z-index:2147483647;padding:12px 18px;background:#18191c;color:#fff;border-radius:6px;font:14px/1.5 sans-serif;max-width:360px';
    document.body.append(notice); setTimeout(() => notice.remove(), 8000);
  }

  async function loadExportMedia(key, token, requestedQuality = 127) {
    const [id, partText] = key.split(':p'), part = Number(partText);
    const controller = new AbortController();
    const identity = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
    const info = await request(`https://api.bilibili.com/x/web-interface/view?${identity}`, false, controller.signal);
    const page = info.data?.pages?.find(item => item.page === part);
    if (info.code !== 0 || !page?.cid) throw new Error('无法确认当前视频或分 P');
    if ((/^BV/.test(id) && info.data.bvid !== undefined && info.data.bvid !== id) || (/^av/i.test(id) && info.data.aid !== undefined && String(info.data.aid) !== id.slice(2))) throw new Error('视频信息与当前页面不一致，请刷新后重试');
    const nav = await request('https://api.bilibili.com/x/web-interface/nav', false, controller.signal);
    const wbi = nav.data?.wbi_img;
    if (!wbi?.img_url || !wbi?.sub_url) throw new Error('无法读取视频接口签名信息');
    const filename = url => new URL(url).pathname.split('/').at(-1).split('.')[0];
    const signed = await helperRequest('/sign-wbi', token, { key: filename(wbi.img_url) + filename(wbi.sub_url), params: { ...(/^av/i.test(id) ? { aid: id.slice(2) } : { bvid: id }), cid: page.cid, qn: requestedQuality, fnval: 4048, fourk: 1 } });
    const streams = await request(`https://api.bilibili.com/x/player/wbi/playurl?${signed.query}`, false, controller.signal);
    const qualities = streams.code === 0 ? downloadQualities(streams.data) : [];
    if (!qualities.length) throw new Error('未取得可下载的音视频画质，请确认登录与权限后重试');
    return { id, part, page, info, dash: streams.data.dash, qualities };
  }

  async function prepareExport(key, range, token, requestedQuality, mediaSnapshot) {
    const media = mediaSnapshot || await loadExportMedia(key, token, requestedQuality || 127);
    const quality = requestedQuality || defaultDownloadQuality(media.qualities);
    const { id, part, page, info, dash } = media;
    if (key !== `${id}:p${part}` || range.end > page.duration) throw new Error('无法确认视频或选区超出当前分 P');
    const controller = new AbortController();
    const identity = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
    const query = `${identity}&cid=${page.cid}`;
    let text = { body: [] };
    let player;
    try { player = await request(`https://api.bilibili.com/x/player/wbi/v2?${query}`, false, controller.signal); }
    catch (error) { throw new Error('字幕信息读取失败，请重试：' + error.message); }
    if (player?.code !== 0) throw new Error('字幕信息读取失败，请刷新或登录后重试');
    if (player.data?.cid !== undefined && player.data.cid !== page.cid) throw new Error('字幕信息与当前分 P 不一致，请重试');
    const subtitles = player?.data?.subtitle?.subtitles || [];
    const sourceHasSubtitles = player?.code === 0 && Array.isArray(player?.data?.subtitle?.subtitles) ? subtitles.length > 0 : undefined;
    const chosen = subtitles.find(item => item.lan === 'zh-CN' || item.lan === 'zh-Hans') || subtitles.find(item => /^ai-zh|^zh/.test(item.lan)) || subtitles[0];
    // Missing subtitles only degrade the export to video-only; the saved note states that.
    if (player?.code === 0 && chosen?.subtitle_url) {
      const subtitleUrl = new URL(chosen.subtitle_url, 'https://www.bilibili.com');
      if (subtitleUrl.protocol !== 'https:' || !['aisubtitle.hdslb.com', 'subtitle.bilibili.com'].includes(subtitleUrl.hostname)) throw new Error('字幕地址暂不支持，请反馈地址域名');
      try { text = await request(subtitleUrl.href, false, controller.signal); }
      catch (error) { throw new Error('字幕下载失败，请重试：' + error.message); }
      if (!Array.isArray(text?.body)) throw new Error('字幕内容格式无效，请重试');
    }
    if (chosen && !chosen.subtitle_url) throw new Error('字幕地址缺失，请重试');
    const cues = Array.isArray(text.body) ? text.body.filter(cue => Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.to > cue.from && cue.to > range.start && cue.from < range.end && typeof cue.content === 'string' && cue.content.trim()) : [];
    if (!cues.length) {
      text = { body: [] };
    }
    const video = selectQualityStream(dash?.video?.filter(selectMediaUrl), quality);
    const audio = dash?.audio?.filter(selectMediaUrl).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!video || !audio) throw new Error('未取得所选下载画质的音视频轨道，请刷新画质列表后重试');
    const videoUrl = selectMediaUrl(video), audioUrl = selectMediaUrl(audio);
    if (!videoUrl || !audioUrl) throw new Error(`未取得可用的${!videoUrl ? '视频' : '音频'}下载地址，请重试；仍失败时请复制排错信息`);
    const descriptor = track => { const base = track.SegmentBase || track.segment_base; return base ? { init: base.Initialization || base.initialization, index: base.indexRange || base.index_range, codec: track.codecs } : undefined; };
    const addresses = track => [...new Set([track.baseUrl, track.base_url, ...(Array.isArray(track.backupUrl) ? track.backupUrl : []), ...(Array.isArray(track.backup_url) ? track.backup_url : [])].filter(url => selectMediaUrl({ baseUrl: url })))].slice(0, 3);
    return { id, part, cid: page.cid, start: range.start, end: range.end, downloadQuality: quality, title: info.data.title, videoUrl, audioUrl, videoUrls: addresses(video), audioUrls: addresses(audio), videoTrack: descriptor(video), audioTrack: descriptor(audio), subtitles: text.body, videoOnly: !cues.length, ...(sourceHasSubtitles === undefined ? {} : { sourceHasSubtitles }) };
  }

  if (typeof GM_registerMenuCommand === 'function' && typeof GM_setValue === 'function') {
    GM_registerMenuCommand('连接片段助手', () => {
      const token = prompt('首次手动连接时粘贴配对码。配对码会长期保存，助手关闭或重启无需重新配对：');
      if (token === null) return;
      if (!/^[a-f0-9]{64}$/.test(token.trim())) { status('配对码格式不正确。', true); return; }
      GM_setValue('export-token', token.trim());
      status('配对码已保存，正在连接 CPod。'); syncHelper();
    });
  }

  function status(message, error = false) {
    if (error) diagnostic.lastError = message;
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.title = '';
    ui.status.dataset.error = String(error);
  }
  function ready() { return media && media.isConnected && media.readyState >= 1 && Number.isFinite(media.duration) && media.duration > 0; }
  function renderMedia() {
    if (!ui) return;
    ensureWatchRoute(); renderWatchTrack();
    const line = ui.density.querySelector('.playhead');
    if (line) {
      const x = 32 + Math.min(1, Math.max(0, (media?.currentTime || 0) / videoDuration)) * 276;
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('visibility', ready() && !restoreAfterRoute ? 'visible' : 'hidden');
    }
    ui.density.setAttribute('aria-disabled', String(!ready() || restoreAfterRoute || !chartData));
  }

  window.addEventListener('pagehide', saveWatch);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveWatch(); });
  function saveWatch() {
    if (!watchDirty || !watchRoute || typeof GM_setValue !== 'function') return;
    try {
      const raw = GM_getValue('watch-history', {});
      const history = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const previous = Array.isArray(history[watchRoute]?.ranges) ? history[watchRoute].ranges : [];
      watchRanges = mergeWatchRanges([...previous, ...watchRanges], 0, 0);
      history[watchRoute] = { ranges: watchRanges, updated: Date.now() };
      const recent = Object.entries(history).sort((a, b) => (b[1]?.updated || 0) - (a[1]?.updated || 0)).slice(0, 200);
      GM_setValue('watch-history', Object.fromEntries(recent)); watchDirty = false; watchSavedAt = performance.now();
    } catch {}
  }
  function ensureWatchRoute() {
    if (watchRoute === currentRoute) return;
    saveWatch(); watchRoute = currentRoute; watchSample = null; watchStart = null;
    try {
      const entry = GM_getValue('watch-history', {})?.[watchRoute];
      watchRanges = mergeWatchRanges(Array.isArray(entry?.ranges) ? entry.ranges : [], 0, 0);
    } catch { watchRanges = []; }
  }
  function recordWatch(event) {
    ensureWatchRoute();
    if (['seeking', 'seeked', 'emptied', 'loadstart', 'waiting', 'error'].includes(event.type)) { watchSample = null; return; }
    if (!ready() || restoreAfterRoute || seeking || media.seeking || loadedRoute !== currentRoute || currentRoute !== routeKey(location.href)) { watchSample = null; return; }
    const playing = !media.paused && !media.ended;
    const terminal = ['pause', 'ended', 'timeupdate'].includes(event.type);
    const sample = { time: Math.max(0, Math.min(media.duration, media.currentTime)), wall: performance.now(), rate: media.playbackRate || 1, playing: playing || Boolean(terminal && watchSample?.playing) };
    const interval = watchedAdvance(watchSample, sample);
    if (interval) {
      if (watchStart === null) watchStart = interval[0];
      watchRanges = mergeWatchRanges(watchRanges, ...interval); watchDirty = true;
    }
    watchSample = playing ? sample : null;
    if (!playing || performance.now() - watchSavedAt > 2000) saveWatch();
  }
  function renderWatchTrack() {
    const track = ui['watch-track'];
    if (!track) return;
    track.hidden = !chartData || !videoDuration || !watchRanges.length;
    ui['watch-start'].hidden = track.hidden || watchStart === null;
    if (track.hidden) return;
    track.style.top = (14 / chartData.height * 100) + '%';
    const validRanges = watchRanges.filter(pair => pair[0] < videoDuration);
    while (track.children.length > validRanges.length) track.lastElementChild.remove();
    validRanges.forEach((pair, index) => {
      let segment = track.children[index];
      if (!segment) {
        segment = document.createElement('span'); segment.className = 'watch-segment'; segment.tabIndex = 0;
        const show = () => {
          ui.tooltip.textContent = segment.dataset.details; ui.tooltip.hidden = false;
        };
        segment.addEventListener('pointerenter', show); segment.addEventListener('focus', show);
        segment.addEventListener('pointerleave', () => { ui.tooltip.hidden = true; }); segment.addEventListener('blur', () => { ui.tooltip.hidden = true; });
        track.append(segment);
      }
      const end = Math.min(pair[1], videoDuration);
      segment.style.left = pair[0] / videoDuration * 100 + '%'; segment.style.width = (end - pair[0]) / videoDuration * 100 + '%';
      segment.dataset.details = `已观看 ${formatTime(pair[0])}–${formatTime(end)} · ${end - pair[0] < 1 ? '不足 1' : Math.round(end - pair[0])} 秒${watchStart !== null ? `\n本次从 ${formatTime(watchStart)} 开始观看` : ''}`;
      segment.setAttribute('aria-label', segment.dataset.details);
    });
    const dot = ui['watch-start'];
    dot.hidden = watchStart === null;
    dot.style.top = (17 / chartData.height * 100) + '%'; dot.style.left = (10 + (watchStart || 0) / videoDuration * 86.25) + '%';
  }

  function drawCloud() {
    ui.cloud.replaceChildren();
    const terms = wordStats(records, phraseMode);
    // 落地编排期间先别急着隐藏骨架，playLanding 会先淡出再收起。
    ui['cloud-empty'].hidden = terms.length > 0 && !settleCharts;
    if (!terms.length) {
      // 空态是纯文字，不能残留加载骨架的粉色光晕。
      ui['cloud-empty'].dataset.load = 'off'; delete ui['cloud-empty'].dataset.phase;
      ui['cloud-empty'].textContent = phraseMode ? '没有重复出现的短语，请切换高频词。' : '暂无可用的弹幕词语';
    }
    ui['cloud-note'].textContent = phraseMode ? '连续 2–4 个词 · 至少 2 条弹幕重复提及' : '单个词语 · 数字为提及它的弹幕条数';
    ui.mode.title = phraseMode ? '统计连续出现的 2–4 个词，保留重复短语；不是语义总结' : '中文分词，按提及该词的弹幕条数排序';
    ui.clear.hidden = !selectedTerm;
    if (!terms.length) return;
    const canvas = document.createElement('canvas').getContext('2d');
    const rect = ui.cloud.getBoundingClientRect();
    const cloudHeight = Math.max(90, rect.height / Math.max(1, rect.width) * 320);
    ui.cloud.setAttribute('viewBox', `0 0 320 ${cloudHeight}`);
    const max = terms[0].count;
    // Pack rows in frequency order; reduce the size range before dropping terms.
    let rows = [], placed = 0;
    for (const ceiling of [28, 24, 20]) {
      const candidate = [];
      let usedHeight = 4;
      for (const term of terms) {
        const size = 12 + (ceiling - 12) * Math.sqrt(term.count / max);
        canvas.font = `${size}px "Microsoft YaHei",sans-serif`;
        const textWidth = canvas.measureText(term.text).width;
        canvas.font = '11px "Microsoft YaHei",sans-serif';
        const w = textWidth + 4 + canvas.measureText(String(term.count)).width;
        const h = size + 9;
        if (w > 312) continue;
        let row = candidate[candidate.length - 1];
        if (!row || row.width + 12 + w > 312) {
          if (usedHeight + h > cloudHeight - 4) break;
          row = { items: [], width: 0, height: h, y: usedHeight };
          candidate.push(row); usedHeight += h;
        }
        row.items.push({ term, size, w });
        row.width += (row.items.length > 1 ? 12 : 0) + w;
      }
      const count = candidate.reduce((sum, row) => sum + row.items.length, 0);
      if (count > placed) { rows = candidate; placed = count; }
      if (count === terms.length) break;
    }
    ui['cloud-note'].textContent += ` · 显示 ${placed} 项`;
    ui['cloud-caption'].title = ui['cloud-note'].textContent;
    for (const row of rows) {
      let x = 4;
      const gap = row.items.length > 1 ? 12 + Math.min(10, (312 - row.width) / (row.items.length - 1)) : 0;
      for (const { term, size, w } of row.items) {
        // 高频词用品牌粉、次档沿用蓝、其余走正文色 —— 只上色，不改字号与排布。
        const rank = term.count / max;
        const tone = rank >= .6 ? 'hot' : rank >= .28 ? 'warm' : '';
        const word = svgNode('text', { x, y: row.y + row.height / 2, 'dominant-baseline': 'central', 'font-size': size, role: 'button', tabindex: 0, class: `${tone}${selectedTerm === term.text ? ' selected' : ''}`, 'aria-pressed': String(selectedTerm === term.text), 'aria-label': `${term.text}，${term.count} 条弹幕提及`, 'data-term': term.text }, term.text);
        word.append(svgNode('tspan', { dx: 4, 'font-size': 11, class: 'term-count' }, String(term.count)));
        word.append(svgNode('title', {}, `${term.count} 条弹幕提及；点击在密度图中显示出现时段`));
        const choose = () => { selectedTerm = selectedTerm === term.text ? '' : term.text; renderCharts(); };
        word.addEventListener('click', choose);
        word.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
        ui.cloud.append(word);
        x += w + gap;
      }
    }
  }

  function drawDensity() {
    ui.density.replaceChildren();
    chartData = density(records, videoDuration, selectedTerm);
    const { bins, width } = chartData;
    const rect = ui.density.getBoundingClientRect();
    const height = Math.max(90, rect.height / Math.max(1, rect.width) * 320);
    const bottom = height - 24;
    chartData.height = height; chartData.bottom = bottom;
    ui.density.setAttribute('viewBox', `0 0 320 ${height}`);
    const max = Math.max(1, ...bins.map(bin => bin.count));
    const x = t => 32 + t / videoDuration * 276;
    const y = count => bottom - count / max * (bottom - 26);
    for (let i = 0; i <= 4; i++) {
      const yy = bottom - (bottom - 26) * i / 4;
      ui.density.append(svgNode('line', { x1: 32, x2: 308, y1: yy, y2: yy, class: 'grid' }));
      if (records.length) ui.density.append(svgNode('text', { x: 26, y: yy + 3, 'text-anchor': 'end', class: 'axis' }, String(Math.round(max * i / 4))));
      const t = videoDuration * i / 4;
      ui.density.append(svgNode('text', { x: x(t), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'axis' }, formatTime(t)));
    }
    const path = field => bins.map((bin, i) => `${i ? 'L' : 'M'}${x(Math.min(videoDuration, bin.time + width / 2)).toFixed(2)},${y(bin[field]).toFixed(2)}`).join(' ');
    if (records.length) {
      ui.density.append(svgNode('path', { d: `M32,${bottom} ${path('count').replace(/^M/, 'L')} L308,${bottom} Z`, class: 'area' }));
      ui.density.append(svgNode('path', { d: path('count'), class: 'curve' }));
      // 局部峰值打一个空心点，给密度的「波峰」一个视觉落点。
      // 密集锯齿数据里相邻 bin 差距很小，所以用「不小于邻点」而不是严格大于是等号，
      // 并跳过比前一个点低的点，否则整条曲线会被点满。
      let previous = -1;
      for (let i = 1; i < bins.length - 1; i++) {
        const count = bins[i].count;
        if (count < max * .4) continue;
        if (count < bins[i - 1].count || count < bins[i + 1].count) continue;
        if (count < previous) continue;
        previous = count;
        ui.density.append(svgNode('circle', { cx: x(Math.min(videoDuration, bins[i].time + width / 2)).toFixed(2), cy: y(count).toFixed(2), r: 2.6, class: 'peak' }));
      }
    } else {
      ui.density.append(svgNode('text', { x: 170, y: (22 + bottom) / 2, 'text-anchor': 'middle', class: 'axis' }, '暂无弹幕，仍可选择截取时段'));
    }
    ui.density.append(svgNode('rect', { x: 32, y: 22, width: 0, height: Math.max(0, bottom - 22), class: 'clip-highlight' }));
    for (let i = 0; i < 2; i++) ui.density.append(svgNode('line', { x1: 32, x2: 32, y1: 22, y2: bottom, class: 'clip-edge' }));
    if (selectedTerm) ui.density.append(svgNode('path', { d: path('selected'), class: 'match' }));
    ui.density.append(svgNode('line', { x1: 32, x2: 32, y1: 22, y2: bottom, class: 'playhead' }));
    ui.density.append(svgNode('line', { x1: 32, x2: 32, y1: 22, y2: bottom, class: 'hover', visibility: 'hidden' }));
    if (selectedTerm) ui.density.append(svgNode('text', { x: 32, y: 13, class: 'axis' }, `橙线：${selectedTerm}`));
    ui['density-empty'].hidden = !settleCharts;
    if (!clipRange && videoDuration >= 1) clipRange = { start: 0, end: Math.min(30, Math.floor(videoDuration)) };
    updateClipUI();
    renderMedia();
  }
  function renderCharts() {
    diagnostic.charts++;
    ui.tooltip.hidden = true;
    drawCloud(); drawDensity();
    // 只有「从加载态进入真实内容」这一跳才给落定高光，
    // 词条点击、模式切换等重绘不该反复闪。
    if (settleCharts) { const fire = settleCharts; settleCharts = null; fire(); }
  }
  function showTooltip(time) {
    if (!chartData) return;
    hoverTime = time;
    const index = Math.min(chartData.bins.length - 1, Math.floor(time / chartData.width));
    const bin = chartData.bins[index];
    const end = Math.min(videoDuration, bin.time + chartData.width);
    const title = document.createElement('div'); title.className = 'detail-title';
    title.textContent = `${formatTime(bin.time)}–${formatTime(end)} · ${bin.count} 条${selectedTerm ? ` ·「${selectedTerm}」${bin.selected} 条` : ''}`;
    const sampleBin = selectedTerm && !bin.samples.length ? chartData.bins[index - 1] : bin;
    const samples = (sampleBin?.samples || []).map(text => {
      const line = document.createElement('div'); line.className = 'detail-sample';
      line.textContent = sampleBin === bin ? text : `邻近 ${formatTime(sampleBin.time)}：${text}`; return line;
    });
    ui.tooltip.replaceChildren(title, ...samples);
    ui.tooltip.hidden = false;
    const xx = 32 + time / videoDuration * 276;
    const line = ui.density.querySelector('.hover');
    line?.setAttribute('x1', xx); line?.setAttribute('x2', xx); line?.setAttribute('visibility', 'visible');
  }

  function request(url, binary, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('已取消')); return; }
      let handle;
      const abort = () => { handle?.abort(); reject(new Error('已取消')); };
      const finish = (error, value) => { signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      signal.addEventListener('abort', abort, { once: true });
      if (typeof GM_xmlhttpRequest !== 'function') { finish(new Error('请在 Tampermonkey 中安装并允许弹幕请求。')); return; }
      handle = GM_xmlhttpRequest({ method: 'GET', url, responseType: binary ? 'arraybuffer' : 'text', timeout: 15000,
        onload: response => {
          if (signal.aborted) return;
          if (response.status !== 200) { finish(new Error(`弹幕请求失败（${response.status}）`)); return; }
          try { finish(null, binary ? response.response : JSON.parse(response.responseText)); }
          catch { finish(new Error('接口返回了无法识别的数据')); }
        }, onerror: () => finish(new Error('弹幕请求失败，请检查网络或登录状态')),
        ontimeout: () => finish(new Error('弹幕请求超时')), onabort: () => finish(new Error('已取消')) });
    });
  }
  // 加载叙事：把「第 N/M 段」这种内部进度换成用户能理解的阶段名。
  // 进度仍由调用方按真实分段数推进，只是文案不再暴露实现细节。
  const LOAD_PHASES = [
    { at: 0, cloud: '接入弹幕流', density: '连接弹幕接口' },
    { at: .35, cloud: '抓取弹幕分段', density: '读取弹幕数据' },
    { at: .8, cloud: '统计高频词', density: '计算弹幕密度' },
    { at: 1, cloud: '排列词云', density: '绘制密度曲线' },
  ];
  function loadPhase(ratio) {
    let phase = LOAD_PHASES[0];
    for (const item of LOAD_PHASES) if (ratio >= item.at) phase = item;
    return phase;
  }
  function showLoadStage(key, ratio) {
    const node = ui[key];
    const phase = loadPhase(ratio);
    const label = phase[key === 'cloud-empty' ? 'cloud' : 'density'];
    // 阶段没变就不动 DOM，避免每段请求都重放一次进场动画。
    if (node.dataset.phase === label) return;
    node.dataset.phase = label;
    node.dataset.load = 'on';
    node.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'load';
    wrap.setAttribute('aria-hidden', 'true');
    const pulse = document.createElement('div');
    pulse.className = 'load-pulse';
    pulse.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const rail = document.createElement('div');
    rail.className = 'load-rail';
    const text = document.createElement('div');
    text.className = 'load-phase phase-in';
    text.textContent = label;
    wrap.append(pulse, rail, text);
    node.append(wrap);
  }
  // 真实内容到达时给一道落定高光，让「加载好了」这件事有明确的落点。
  // 落地衔接：把「骨架 → 真实内容」这一跳做成有次序的编排，而不是整块替换。
  // 顺序是 骨架淡出 → 边框落定高光 → 折线自左向右画出 → 词条按行错峰浮现 → 峰值点点亮。
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function playLanding() {
    const cloud = ui.cloud, density = ui.density;
    const curve = density.querySelector('.curve'), area = density.querySelector('.area');
    const peaks = [...density.querySelectorAll('.peak')];
    const words = [...cloud.querySelectorAll('text')];
    const instant = reducedMotion();

    // 1) 骨架淡出，别让它和真内容抢同一帧
    for (const key of ['cloud-empty', 'density-empty']) {
      const node = ui[key];
      node.classList.add('leaving');
      setTimeout(() => { node.hidden = true; node.classList.remove('leaving'); }, instant ? 0 : 300);
    }
    // 2) 边框高光
    for (const figure of [cloud.closest('figure'), ui.timeline]) {
      if (!figure) continue;
      figure.classList.remove('settle');
      void figure.offsetWidth;
      figure.classList.add('settle');
      setTimeout(() => figure.classList.remove('settle'), 640);
    }

    if (instant) return;

    // 3) 折线自左向右画出。getTotalLength 给的是用户单位长度，
    // 而 density 带 preserveAspectRatio=none，所以这里不能用 getBoundingClientRect 的宽度。
    if (curve) {
      const length = Math.ceil(curve.getTotalLength());
      curve.style.setProperty('--len', length);
      curve.classList.add('enter');
      setTimeout(() => curve.classList.remove('enter'), 900);
    }
    if (area) { area.classList.add('enter'); setTimeout(() => area.classList.remove('enter'), 760); }
    // drawCloud 已按行、从左到右插入词条，直接沿用 DOM 顺序。
    words.forEach((word, index) => { word.style.animationDelay = (90 + index * 26) + 'ms'; });
    cloud.classList.add('enter');
    // 峰值点跟随折线收尾再亮
    peaks.forEach((peak, i) => { peak.style.animationDelay = (620 + i * 40) + 'ms'; peak.classList.add('enter'); });
    const total = 90 + words.length * 26 + 420;
    setTimeout(() => {
      cloud.classList.remove('enter');
      for (const word of words) word.style.removeProperty('animation-delay');
      for (const peak of peaks) { peak.classList.remove('enter'); peak.style.removeProperty('animation-delay'); }
    }, total + 200);
  }
  function loading(message, retry = false, ratio = 0) {
    chartData = null; records = [];
    rangeDrag = null; updateClipUI();
    ui['cloud-note'].textContent = '';
    ui.cloud.replaceChildren(); ui.density.replaceChildren(); ui.tooltip.hidden = true; ui.clear.hidden = true;
    for (const key of ['cloud-empty', 'density-empty']) {
      const node = ui[key];
      node.hidden = false;
      if (retry) {
        // 出错时保持纯文字 + 重试按钮，不显示加载骨架。
        node.dataset.load = 'off'; delete node.dataset.phase;
        node.replaceChildren(document.createTextNode(message));
        if (key === 'density-empty') {
          const button = document.createElement('button'); button.textContent = '重试';
          button.addEventListener('click', () => loadData(currentRoute, true)); node.append(button);
        }
      } else showLoadStage(key, ratio);
    }
    status(''); renderMedia();
    // 埋下落定高光：只有接下来这次 renderCharts 是真数据落地时才闪。
    if (!retry) settleCharts = playLanding;
  }
  async function loadData(key, force = false) {
    if (dataRoute === key && !force) return;
    dataRequest?.abort();
    if (dataRoute !== key) { clipRange = null; ui['clip-start'].value = ''; ui['clip-end'].value = ''; }
    dataRoute = key; selectedTerm = '';
    const controller = new AbortController(); dataRequest = controller;
    loading('正在加载弹幕…');
    const valid = () => !controller.signal.aborted && currentRoute === key && routeKey(location.href) === key;
    try {
      let entry = !force && cache.get(key);
      if (!entry || Date.now() - entry.at > 300000) {
        // Keep only the current part; release the previous dataset before fetching.
        cache.clear();
        const [id, part] = key.split(':p');
        // Prefer metadata already delivered with the page; never execute page script text.
        let pageData;
        for (const script of document.scripts) {
          pageData = parsePageState(script.textContent, id);
          if (pageData) break;
        }
        const info = pageData ? { code: 0, data: pageData } : await request(`https://api.bilibili.com/x/web-interface/view?${/^av/i.test(id) ? 'aid=' + id.slice(2) : 'bvid=' + id}`, false, controller.signal);
        if (info.code !== 0 || !info.data?.pages) throw new Error('无法读取视频信息，请刷新或登录后重试');
        const page = info.data.pages.find(p => p.page === Number(part));
        if (!page || !(page.duration > 0) || !page.cid || !info.data.aid) throw new Error('未找到当前分 P 的弹幕');
        const total = Math.ceil(page.duration / 360);
        if (total > 120) throw new Error('当前分 P 超过 12 小时，暂不支持');
        const all = [], ids = new Set();
        // Sequential requests keep the userscript small and avoid bursts of requests.
        for (let index = 1; index <= total; index++) {
          if (!valid()) return;
          // 真实进度推进阶段文案，不再显示 2/7 这类内部计数。
          // 仍走 loading() 这一个入口，测试沙箱替换 loading 即可隔离视图层。
          if (total > 1) loading('', false, (index - 1) / (total - 1));
          const buffer = await request(`https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${page.cid}&pid=${info.data.aid}&segment_index=${index}`, true, controller.signal);
          const decoded = decodeDanmaku(buffer);
          if (decoded.state === 1) break;
          for (const r of decoded.records) {
            if (r.id && ids.has(r.id)) continue;
            if (r.id) ids.add(r.id);
            // IDs are needed only during download deduplication, not by either chart.
            all.push({ time: r.time, text: r.text, mode: r.mode, pool: r.pool });
          }
          if (all.length > 150000) throw new Error('弹幕超过 15 万条，暂不支持');
        }
        if (!valid()) return;
        entry = { records: all, duration: page.duration, at: Date.now() };
        cache.set(key, entry);
      }
      if (!valid()) return;
      records = entry.records; videoDuration = entry.duration;
      renderCharts(); status('');
    } catch (error) { if (valid()) loading(error.message, true); }
    finally { if (dataRequest === controller) dataRequest = null; }
  }

  function onMediaState(event) {
    diagnostic.mediaEvents++;
    if (event.type === 'emptied' || event.type === 'loadstart') {
      loadedRoute = null;
      cancelSeek();
      status('视频正在加载…');
    } else if (event.type === 'error') status('播放器加载失败，暂时无法定位。', true);
    else if (event.type === 'loadedmetadata' || event.type === 'durationchange') {
      if (ready()) loadedRoute = routeKey(location.href);
      restoreAfterRoute = false;
      status('');
    }
    recordWatch(event); renderMedia();
  }

  const MEDIA_EVENTS = ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied', 'loadstart', 'error', 'seeking', 'seeked', 'play', 'playing', 'pause', 'waiting', 'ended'];
  function cancelSeek() {
    pendingSeek?.abort();
    pendingSeek = null;
    seeking = false;
  }

  function bindMedia(next) {
    if (media === next) return;
    cancelSeek();
    if (media) for (const event of MEDIA_EVENTS) media.removeEventListener(event, onMediaState);
    saveWatch(); watchSample = null; media = next;
    if (media) for (const event of MEDIA_EVENTS) media.addEventListener(event, onMediaState);
    restoreAfterRoute = false;
    loadedRoute = ready() ? currentRoute : null;
    status('');
    renderMedia();
  }

  async function jump(seconds) {
    diagnostic.seeks++; diagnostic.lastSeek = seconds;
    // A player can be replaced between DOM observation and the user's click.
    if (routeKey(location.href) !== currentRoute || routeKey(location.href) !== dataRoute) { reconcile(); return; }
    bindMedia(findMedia());
    if (restoreAfterRoute) { status('分 P 正在切换，请等待播放器加载后重试。', true); return; }
    cancelSeek();
    const request = new AbortController();
    pendingSeek = request;
    seeking = true;
    renderMedia();
    clearTimeout(seekNoticeTimer);
    ui['seek-status'].textContent = `正在定位到 ${formatTime(seconds)}…`;
    try {
      const result = await seekMedia(media, seconds, request.signal);
      if (pendingSeek === request) {
        ui['seek-status'].textContent = `已定位到 ${formatTime(result.actual)}。`;
        seekNoticeTimer = setTimeout(() => { ui['seek-status'].textContent = ''; }, 2000);
      }
    } catch (error) {
      if (pendingSeek === request) { ui['seek-status'].textContent = ''; status(error.message, true); }
    } finally {
      if (pendingSeek === request) { pendingSeek = null; seeking = false; renderMedia(); }
    }
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findMedia() {
    const players = [...document.querySelectorAll(PLAYER)].filter(visible);
    const candidates = [...new Set(players.flatMap(player => [...player.querySelectorAll(MEDIA)]))]
      .filter(element => visible(element) && typeof element.currentTime === 'number');
    // Restrict to the main player's media, never recommendation previews elsewhere on the page.
    return candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0] || null;
  }

  function destination() {
    const up = [...document.querySelectorAll(UP)].find(node => node.closest(RIGHT) && visible(node));
    if (up?.parentElement) return { parent: up.parentElement, before: up.nextSibling === host ? host.nextSibling : up.nextSibling, mode: 'sidebar' };
    const recommendations = [...document.querySelectorAll(RECOMMEND)];
    for (const anchor of recommendations) {
      if (anchor.closest(RIGHT) && visible(anchor)) return { parent: anchor.parentElement, before: anchor, mode: 'sidebar' };
    }
    // Older layouts may expose cards directly inside the right rail.
    const card = [...document.querySelectorAll('.video-page-card-small')].find(item => item.closest(RIGHT) && visible(item));
    if (card) return { parent: card.parentElement, before: card, mode: 'sidebar' };
    const player = [...document.querySelectorAll(PLAYER)].find(visible);
    if (player?.parentElement) return { parent: player.parentElement, before: player.nextSibling === host ? host.nextSibling : player.nextSibling, mode: 'below' };
    return null;
  }

  function restoreRail() {
    if (alignedRail) alignedRail.style.marginTop = originalRailMargin;
    alignedRail = null;
    host?.style.removeProperty('--card-height');
  }
  function alignRail() {
    const player = [...document.querySelectorAll(PLAYER)].find(visible);
    const rail = host?.dataset.placement === 'sidebar' ? host.parentElement : null;
    if (!player || !rail || !visible(host) || rail.getBoundingClientRect().left < player.getBoundingClientRect().right - 2) { restoreRail(); return; }
    if (alignedRail !== rail) {
      restoreRail(); alignedRail = rail; originalRailMargin = rail.style.marginTop;
    }
    const cardHeight = Math.max(130, (player.getBoundingClientRect().height - 20) / 2);
    const previousHeight = host.style.getPropertyValue('--card-height');
    if (previousHeight !== `${cardHeight}px`) host.style.setProperty('--card-height', `${cardHeight}px`);
    // Move the rail in normal layout: UP information rises above the player row,
    // while the top cloud aligns with the player's top edge. Recommendations stay in flow.
    const delta = player.getBoundingClientRect().top - host.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) rail.style.marginTop = `${(parseFloat(getComputedStyle(rail).marginTop) || 0) + delta}px`;
    if (previousHeight !== `${cardHeight}px` && chartData) renderCharts();
  }

  function theme() {
    if (!host?.isConnected) return;
    if (host.hasAttribute('data-overlay')) { host.dataset.theme = 'dark'; return; }
    let color;
    for (let node = host.parentElement; node; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') { color = value; break; }
    }
    const channels = color?.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const darkness = channels ? channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < 140
      : matchMedia('(prefers-color-scheme: dark)').matches;
    host.dataset.theme = darkness ? 'dark' : 'light';
  }

  function setOverlayExpanded(expanded) {
    clearTimeout(overlayCloseTimer);
    host.toggleAttribute('data-expanded', expanded);
    host.shadowRoot.getElementById('panel-content').inert = host.hasAttribute('data-overlay') && !expanded;
    host.shadowRoot.getElementById('edge-trigger').setAttribute('aria-expanded', String(expanded));
  }

  function queueOverlayClose() {
    clearTimeout(overlayCloseTimer);
    if (!host?.hasAttribute('data-overlay')) return;
    overlayCloseTimer = setTimeout(() => {
      const shadow = host.shadowRoot;
      const focused = shadow.activeElement;
      if (shadow.getElementById('overlay-pin').getAttribute('aria-pressed') === 'true' || rangeDrag ||
          shadow.querySelector('dialog[open]') || focused?.matches('input,textarea,select') ||
          shadow.getElementById('panel-content').matches(':hover') || shadow.getElementById('edge-trigger').matches(':hover')) return;
      if (focused) focused.blur();
      setOverlayExpanded(false);
    }, 500);
  }

  function layoutVisibility() {
    if (!host) return;
    const player = media?.closest(PLAYER);
    const full = document.fullscreenElement;
    const wide = player?.querySelector('.bpx-state-web, .bpx-state-full') || (player?.matches('.bpx-state-web, .bpx-state-full') ? player : null);
    const target = full && media && full.contains(media) && !full.matches(MEDIA) ? full : !full && wide ? (wide.contains(media) ? wide : player) : null;
    const changed = host.hasAttribute('data-overlay') !== Boolean(target);
    host.hidden = Boolean(full && !target);
    if (target) {
      restoreRail();
      if (host.parentElement !== target) target.append(host);
      host.dataset.overlay = '';
      host.dataset.placement = 'overlay';
      host.style.setProperty('pointer-events', 'none', 'important');
    } else {
      host.removeAttribute('data-overlay');
      host.style.setProperty('pointer-events', 'auto', 'important');
      const place = destination();
      if (place) {
        if (host.parentElement !== place.parent || host.nextSibling !== place.before) place.parent.insertBefore(host, place.before);
        host.dataset.placement = place.mode;
      }
    }
    if (changed) {
      host.shadowRoot.getElementById('overlay-pin').setAttribute('aria-pressed', 'false');
      host.shadowRoot.getElementById('overlay-pin').title = '固定展开';
      host.shadowRoot.getElementById('overlay-pin').setAttribute('aria-label', '固定展开');
      setOverlayExpanded(false);
    }
    theme();
    if (target && chartData) renderCharts();
  }

  function reconcile() {
    diagnostic.reconciles++;
    scheduled = null;
    const key = !managed() || helperOnline ? routeKey(location.href) : null;
    if (!key) {
      cancelSeek();
      dataRequest?.abort(); dataRoute = null;
      cache.clear(); records = []; chartData = null;
      if (ui) { ui.cloud.replaceChildren(); ui.density.replaceChildren(); }
      restoreRail();
      bindMedia(null);
      observePlayerMode();
      host?.remove();
      currentRoute = null;
      return;
    }
    // The public video HTML is a Vue SSR tree. Tampermonkey's document-idle
    // does not mean Bilibili has hydrated it. An extra child inside that tree
    // changes the nodes the native app is about to claim. Wait without creating
    // a panel, changing rail styles, or issuing data requests. Vue removes this
    // attribute when hydration starts; the next task runs after that sync work.
    if (document.readyState === 'loading' || document.getElementById('app')?.getAttribute('data-server-rendered') === 'true') {
      schedule(250);
      return;
    }
    const changed = currentRoute && currentRoute !== key;
    if (!host) createPanel();
    if (changed) {
      cancelSeek();
      status('视频或分 P 已切换，正在重新连接播放器…');
    }
    currentRoute = key;
    const next = findMedia();
    const previous = media;
    bindMedia(next);
    if (changed && next === previous && ready() && loadedRoute !== key) {
      // Bilibili can retain the same element while replacing its media source.
      restoreAfterRoute = true;
      status('视频或分 P 已切换，等待新视频加载。');
    }
    loadData(key);
    renderMedia();
    theme();
    layoutVisibility();
    alignRail();
    observePlayerMode();
  }

  function schedule(delay = 120) {
    // Event listeners pass an Event here; only explicit numeric delays count.
    if (!scheduled) scheduled = setTimeout(reconcile, typeof delay === 'number' ? delay : 120);
  }

  const important = `${RIGHT}, ${RECOMMEND}, ${PLAYER}, ${MEDIA}, ${UP}, .video-page-card-small`;
  const observer = new MutationObserver(records => {
    if (managed() && !helperOnline) return;
    if (routeKey(location.href) !== currentRoute) { schedule(); return; }
    for (const record of records) {
      if (record.type === 'attributes') { schedule(); return; }
      // Animated danmaku and control nodes cannot change rail placement.
      if (record.target.nodeType === 1 && record.target.closest(PLAYER)) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType === 1 && (node.matches(MEDIA) || node.querySelector(MEDIA))) { schedule(); return; }
        }
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node === host) continue;
        if (node.nodeType === 1 && (node.matches(important) || node.querySelector(important) || node.contains(host))) {
          schedule(); return;
        }
      }
    }
  });
  const themeObserver = new MutationObserver(theme);
  function observePage() {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-server-rendered'] });
    // Only observe root theme attributes, not every animated danmaku node.
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  const playerModeObserver = new MutationObserver(records => {
    if (records.some(record => record.target === observedPlayer || record.target.matches('.bpx-state-web, .bpx-state-full') || /\bbpx-state-(web|full)\b/.test(record.oldValue || ''))) schedule();
  });
  const sizeObserver = new ResizeObserver(schedule);
  let observedPlayer;
  const observePlayerMode = () => {
    const player = media?.closest(PLAYER);
    if (player !== observedPlayer) {
      playerModeObserver.disconnect();
      sizeObserver.disconnect();
      if (player) playerModeObserver.observe(player, { attributes: true, subtree: true, attributeOldValue: true, attributeFilter: ['class'] });
      if (player) sizeObserver.observe(player);
      observedPlayer = player;
    }
  };
  window.addEventListener('urlchange', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('fullscreenchange', schedule);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !pageSuspended) syncHelper(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme);
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    pageSuspended = true; clearTimeout(helperTimer);
    themeObserver.disconnect();
    playerModeObserver.disconnect();
    sizeObserver.disconnect();
    observedPlayer = null;
    cancelSeek();
    dataRequest?.abort(); dataRoute = null;
    dataRequest = null;
    cache.clear(); records = []; chartData = null;
    if (media) bindMedia(null);
    if (ui) { ui.cloud.replaceChildren(); ui.density.replaceChildren(); }
    clearTimeout(scheduled);
    scheduled = null;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { pageSuspended = false; observePage(); syncHelper(); schedule(); }
  });
  function diagnosticReport() {
    const describe = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), id: element.id, class: String(element.className?.baseVal ?? element.className ?? '').slice(0, 100),
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents, position: style.position, zIndex: style.zIndex };
    };
    const safeValue = (element, name) => {
      try {
        const value = element[name];
        return ['number', 'boolean', 'string'].includes(typeof value) ? value : `[${typeof value}]`;
      } catch { return '[unreadable]'; }
    };
    const candidates = [...document.querySelectorAll(MEDIA)].slice(0, 8).map(element => ({ ...describe(element),
      inMainPlayer: Boolean(element.closest(PLAYER)), selected: element === media, connected: element.isConnected,
      currentTime: safeValue(element, 'currentTime'), duration: safeValue(element, 'duration'), readyState: safeValue(element, 'readyState'),
      paused: safeValue(element, 'paused'), seeking: safeValue(element, 'seeking'), hasOpenShadow: Boolean(element.shadowRoot) }));
    const ancestors = [];
    for (let element = host; element && ancestors.length < 5; element = element.parentElement) ancestors.push(describe(element));
    let hit = null;
    if (ui?.density) {
      const rect = ui.density.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height * .55;
      const top = document.elementFromPoint(x, y);
      const inner = host.shadowRoot.elementFromPoint?.(x, y);
      hit = { documentTarget: describe(top), shadowTarget: describe(inner), reachesPanel: top === host, reachesDensity: Boolean(inner && (inner === ui.density || ui.density.contains(inner))) };
    }
    const images = [...document.images];
    return { version: host?.dataset.version, route: routeKey(location.href), elapsedSeconds: Math.round((Date.now() - diagnostic.started) / 1000),
      counters: { ...diagnostic }, states: { currentRoute, dataRoute, loadedRoute, restoreAfterRoute, ready: Boolean(ready()),
        mediaBound: Boolean(media), chartReady: Boolean(chartData), records: records.length, videoDuration, phraseMode, seeking,
        panelConnected: Boolean(host?.isConnected), panelHidden: host?.hidden, managedByCPod: managed(), helperOnline, helperPort: helperPort(), densityDisabled: ui?.density.getAttribute('aria-disabled'),
        status: ui?.status.textContent, railMargin: alignedRail?.style.marginTop, originalRailMargin },
      candidates, ancestors, hit,
      page: { loadingState: document.readyState, serverRendered: document.getElementById('app')?.getAttribute('data-server-rendered') ?? null,
        waitingForNativePage: !host && document.getElementById('app')?.getAttribute('data-server-rendered') === 'true',
        images: images.length, loadedImages: images.filter(image => image.complete && image.naturalWidth > 0).length,
        skeletonNodes: document.querySelectorAll('[class*="skeleton"]').length, commentRoot: Boolean(document.querySelector('#comment, .reply-list, .comment-container')),
        viewport: { width: innerWidth, height: innerHeight } } };
  }
  if (typeof GM_registerMenuCommand === 'function' && typeof GM_setClipboard === 'function') {
    GM_registerMenuCommand('复制排错信息', () => {
      try { GM_setClipboard(JSON.stringify(diagnosticReport(), null, 2), 'text'); status('排错信息已复制，请粘贴到聊天中。'); }
      catch (error) { status(`无法复制排错信息：${error.message}`, true); }
    });
  }
  observePage();
  reconcile();
  connectFromCPod().finally(syncHelper);
})();
