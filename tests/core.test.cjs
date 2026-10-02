const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatTime, routeKey, seekMedia } = require('../Bili-Peek.user.js');

class Media extends EventTarget {
  constructor({ paused = true, refuse = false } = {}) {
    super();
    this.readyState = 4;
    this.duration = 120;
    this.paused = paused;
    this.seeking = false;
    this.refuse = refuse;
    this.position = 0;
  }
  get currentTime() { return this.position; }
  set currentTime(time) {
    this.seeking = true;
    setTimeout(() => {
      if (!this.refuse) this.position = time;
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    }, 15);
  }
  play() { throw new Error('Seeking must not start playback.'); }
  pause() { throw new Error('Seeking must not stop playback.'); }
}

test('format durations and isolate video/part identity from tracking parameters', () => {
  assert.equal(formatTime(100.9), '1:40');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(Infinity), '--:--');
  assert.equal(routeKey('https://www.bilibili.com/video/BV123ABC/?p=2&spm_id_from=abc'), 'BV123ABC:p2');
  assert.equal(routeKey('https://www.bilibili.com/video/BV123ABC/?p=0'), 'BV123ABC:p1');
  assert.equal(routeKey('https://www.bilibili.com/'), null);
});

test('wait for actual seeking and preserve paused state', async () => {
  const media = new Media();
  const promise = seekMedia(media, 100);
  assert.equal(media.currentTime, 0);
  const result = await promise;
  assert.equal(result.actual, 100);
  assert.equal(media.paused, true);
});

test('preserve playing state', async () => {
  const media = new Media({ paused: false });
  await seekMedia(media, 30);
  assert.equal(media.currentTime, 30);
  assert.equal(media.paused, false);
});

test('reject out-of-range and unready requests without seeking', async () => {
  const media = new Media();
  await assert.rejects(seekMedia(media, 121), /超出/);
  await assert.rejects(seekMedia(media, -1), /超出/);
  media.readyState = 0;
  await assert.rejects(seekMedia(media, 10), /尚未就绪/);
  assert.equal(media.currentTime, 0);
});

test('cancel pending seeking when video/part changes', async () => {
  const controller = new AbortController();
  const result = seekMedia(new Media(), 30, controller.signal);
  controller.abort();
  await assert.rejects(result, /已切换/);
});

test('reject a detached old player before changing its position', async () => {
  const media = new Media();
  media.isConnected = false;
  await assert.rejects(seekMedia(media, 30), /尚未就绪/);
  assert.equal(media.currentTime, 0);
});

test('reject source replacement during seeking', async () => {
  const media = new Media();
  const promise = seekMedia(media, 30);
  media.dispatchEvent(new Event('emptied'));
  await assert.rejects(promise, /播放器已切换/);
});

test('do not report success when the player refuses a seek', async () => {
  await assert.rejects(seekMedia(new Media({ refuse: true }), 30), /未能确认/);
});
