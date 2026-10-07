const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeWatchRanges, watchedAdvance } = require('../Bili-Peek.user.js');
test('saving watch history merges another tab instead of overwriting its intervals', () => {
  const source = require('node:fs').readFileSync(require.resolve('../Bili-Peek.user.js'), 'utf8');
  const vm = require('node:vm'); let saved;
  const state = { watchDirty: true, watchRoute: 'BVtest:p1', watchRanges: [[10, 12]], mergeWatchRanges, performance,
    GM_getValue: () => ({ 'BVtest:p1': { ranges: [[2, 4]] } }), GM_setValue: (_, value) => { saved = value; } };
  vm.createContext(state); vm.runInContext(source.slice(source.indexOf('  function saveWatch()'), source.indexOf('  function ensureWatchRoute()')), state);
  state.saveWatch(); assert.deepEqual(saved['BVtest:p1'].ranges, [[2, 4], [10, 12]]);
});
test('watch intervals merge overlaps but preserve skipped gaps and reject corrupt history', () => {
  assert.deepEqual(mergeWatchRanges([[2, 4], [10, 12], [NaN, 5], [-1, 2]], 3.5, 6), [[2, 6], [10, 12]]);
  assert.deepEqual(mergeWatchRanges([[2, 6]], 6.01, 7), [[2, 7]]);
  assert.deepEqual(mergeWatchRanges([[2, 6]], 8, 9), [[2, 6], [8, 9]]);
});
test('watching requires actual forward playback consistent with wall time and playback rate', () => {
  const previous = { time: 20, wall: 1000, rate: 1, playing: true };
  const next = { time: 20.25, wall: 1250, rate: 1, playing: true };
  assert.deepEqual(watchedAdvance(previous, next), [20, 20.25]);
  assert.equal(watchedAdvance(previous, { ...next, playing: false }), null);
  assert.equal(watchedAdvance({ ...previous, playing: false }, next), null);
  assert.equal(watchedAdvance(previous, { ...next, time: 80 }), null);
  assert.equal(watchedAdvance(previous, { ...next, time: 10 }), null);
  assert.equal(watchedAdvance(previous, { ...next, wall: 10000 }), null);
  assert.deepEqual(watchedAdvance({ ...previous, rate: 2 }, { ...next, time: 20.5, rate: 2 }), [20, 20.5]);
});
