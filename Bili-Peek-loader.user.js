// ==UserScript==
// @name         Bili-Peek · 弹幕观看助手
// @namespace    bili-peek
// @version      1.0.0
// @description  固定加载器：使用 CPod 已验证版本，后续更新只需刷新页面。
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
// @grant        window.onurlchange
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      subtitle.bilibili.com
// @connect      127.0.0.1
// ==/UserScript==

(async () => {
  'use strict';
  const cacheKey = 'cpod-verified-runtime';
  async function verified(runtime) {
    if (!runtime || typeof runtime.code !== 'string' || runtime.code.length > 2000000 ||
        typeof runtime.version !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.sha256 || '')) throw new Error('更新内容格式无效');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runtime.code));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== runtime.sha256) throw new Error('更新内容校验失败');
    return runtime;
  }
  let runtime;
  try {
    const response = await new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url: 'http://127.0.0.1:18767/runtime', timeout: 1500,
      onload: response => response.status === 200 ? resolve(response) : reject(new Error('已发布版本暂不可用')),
      onerror: () => reject(new Error('CPod 更新服务未启动')), ontimeout: () => reject(new Error('CPod 更新服务响应超时'))
    }));
    runtime = await verified(JSON.parse(response.responseText));
    GM_setValue(cacheKey, runtime);
  } catch (error) {
    try { runtime = await verified(GM_getValue(cacheKey, null)); }
    catch { console.error('Bili-Peek:', error.message); alert('Bili-Peek：请先在 CPod 更新此项目，再刷新页面。'); return; }
  }
  // Explicitly retain the original userscript grants and storage identity.
  const execute = new Function('GM_xmlhttpRequest', 'GM_registerMenuCommand', 'GM_setClipboard', 'GM_getValue', 'GM_setValue', 'unsafeWindow', runtime.code);
  execute(GM_xmlhttpRequest, GM_registerMenuCommand, GM_setClipboard, GM_getValue, GM_setValue, unsafeWindow);
})();
