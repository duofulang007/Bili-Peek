const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const after = require('../Bili-Peek.user.js');
const before = process.argv[2] ? require(path.resolve(process.argv[2])) : null;

function measure(run) {
  run();
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now(); run(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return +times[2].toFixed(2);
}

const repeated = Array.from({ length: 10000 }, (_, i) => ({ text: ['512GB服务器内存价格上涨', '金条比内存便宜', '普通电脑主板支持容量'][i % 3], mode: 1, pool: 0 }));
const diverse = Array.from({ length: 4000 }, (_, i) => ({ text: `服务器内存型号${Math.floor(i / 2)}价格上涨`, mode: 1, pool: 0 }));
for (const [label, rows, phrases] of [['words/repeated', repeated, false], ['phrases/diverse', diverse, true]]) {
  if (before) assert.deepEqual(after.wordStats(rows, phrases), before.wordStats(rows, phrases));
  // A fresh array bypasses the result cache, measuring actual computation.
  const afterMs = measure(() => after.wordStats([...rows], phrases));
  const beforeMs = before && measure(() => before.wordStats([...rows], phrases));
  console.log(JSON.stringify({ label, records: rows.length, beforeMs, afterMs, speedup: beforeMs && +(beforeMs / afterMs).toFixed(2) }));
}

const rows = Array.from({ length: 150000 }, (_, i) => ({ time: i % 160, text: `内存${i % 17}`, mode: 1, pool: 0 }));
const chart = after.density(rows, 160, '内存');
function scan(index) {
  return [...new Set(rows.filter(r => r.time >= index && (r.time < index + 1 || (index === 159 && r.time === 160)) && r.mode <= 6 && r.text.normalize('NFKC').toLowerCase().replace(/\s+/g, '').includes('内存')).map(r => r.text))].slice(0, 3);
}
for (let i = 0; i < 160; i++) assert.deepEqual(chart.bins[i].samples, scan(i));
if (before) assert.deepEqual(chart.bins.map(({ samples, ...bin }) => bin), before.density(rows, 160, '内存').bins);
const beforeMs = measure(() => { for (let i = 0; i < 160; i++) scan(i); });
const afterMs = measure(() => { for (let i = 0; i < 160; i++) chart.bins[i].samples.map(text => text.slice(0, 48)).join('\n'); });
console.log(JSON.stringify({ label: 'tooltip/160 moves', records: rows.length, beforeMs, afterMs, setupMs: measure(() => after.density(rows, 160, '内存')) }));
