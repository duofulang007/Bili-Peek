const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeDanmaku, density, wordStats, parsePageState } = require('../Bili-Peek.user.js');
function vi(value) { value=BigInt(value); const bytes=[]; do {bytes.push(Number(value&127n)|(value>127n?128:0)); value>>=7n;}while(value); return Buffer.from(bytes); }
function f(n,value,string=false) {const b=Buffer.isBuffer(value)?value:Buffer.from(String(value)); return string?Buffer.concat([vi(n*8+2),vi(b.length),b]):Buffer.concat([vi(n*8),vi(value)]);}
test('read only matching page metadata without evaluating trailing scripts or quoted braces',()=>{
  const state={videoData:{bvid:'BV123',aid:7,title:'括号 } 和引号 "',pages:[{page:1,cid:9,duration:10}]}};
  const source='window.__INITIAL_STATE__='+JSON.stringify(state)+';throw new Error("must not execute")';
  assert.deepEqual(parsePageState(source,'BV123'),state.videoData);
  assert.deepEqual(parsePageState(source,'av7'),state.videoData);
  assert.equal(parsePageState(source,'BV456'),null);
  assert.equal(parsePageState('window.__INITIAL_STATE__={oops};','BV123'),null);
});
test('protobuf retains large IDs, millisecond time and UTF8 text, skips unknown fields',()=>{
  const elem=Buffer.concat([f(1,9007199254740993n),f(2,100125),f(3,1),f(7,'512GB内存',true),f(22,'特效',true)]);
  const decoded=decodeDanmaku(Buffer.concat([f(1,elem,true),f(9,3)]));
  assert.deepEqual(decoded.records[0],{id:'9007199254740993',time:100.125,text:'512GB内存',mode:1,pool:0});
});
test('protobuf rejects truncated messages, JSON and invalid wire types instead of showing zero',()=>{
  for(const buffer of [Buffer.from([10,5,8]),Buffer.from('{"code":-352}'),Buffer.from([15]),Buffer.from([8,128])]) assert.throws(()=>decodeDanmaku(buffer));
  assert.deepEqual(decodeDanmaku(Buffer.alloc(0)),{records:[],state:0});
  assert.equal(decodeDanmaku(f(2,1)).state,1);
});
test('density preserves repeated messages, boundary times and matched-word counts',()=>{
  const rows=[{time:0,text:'内存'},{time:0,text:'内存'},{time:100,text:'金条'},{time:160,text:'内存'},{time:161,text:'范围外'}];
  const data=density(rows,160,'内存');
  assert.equal(data.width,1); assert.equal(data.bins[0].count,2);
  assert.equal(data.bins[0].selected,2);assert.equal(data.bins[159].count,1);
  assert.equal(data.bins.reduce((sum,b)=>sum+b.count,0),4);
});
test('word cloud counts distinct messages per term, keeps model numbers and compound nouns',()=>{
  const rows=['512GB服务器内存内存','512GB内存','金条比内存便宜'].map(text=>({text,mode:1,pool:0}));
  const stats=wordStats(rows);
  assert.equal(stats.find(t=>t.text==='内存').count,3);
  assert.equal(stats.find(t=>t.text==='512GB').count,2);
  assert.equal(stats.find(t=>t.text==='服务器').count,1);
  assert.ok(stats.find(t=>t.text==='金条'));
  assert.ok(!stats.find(t=>t.text==='比'));
});
test('phrase mode does not cross punctuation or stopword boundaries and removes redundant nested phrases',()=>{
  const rows=['内存价格上涨，黄金下跌','内存价格上涨，黄金下跌'].map(text=>({text,mode:1,pool:0}));
  const stats=wordStats(rows,true);
  assert.ok(stats.find(t=>t.text==='内存价格上涨'));
  assert.ok(!stats.find(t=>t.text.includes('上涨黄金')));
  assert.ok(!stats.find(t=>t.text==='内存价格'));
  assert.deepEqual(wordStats([{text:'内存价格',mode:8,pool:2}],false),[]);
});

test('tooltip samples keep three distinct matching originals, including the final boundary',()=>{
  const rows = [
    { time: -1, text: '范围外', mode: 1 },
    { time: 0, text: 'ＡＢＣ 内存', mode: 1 },
    { time: 0, text: 'ＡＢＣ 内存', mode: 1 },
    { time: 0, text: 'abc代码', mode: 8 },
    { time: 0, text: '其他', mode: 1 },
    ...['abc第二', 'abc第三', 'abc第四'].map(text => ({ time: 0, text, mode: 1 })),
    { time: 160, text: 'abc末尾', mode: 1 },
    { time: 161, text: 'abc范围外', mode: 1 },
  ];
  const selected = density(rows, 160, 'abc');
  assert.equal(selected.bins[0].count, 7);
  assert.equal(selected.bins[0].selected, 6);
  assert.deepEqual(selected.bins[0].samples, ['ＡＢＣ 内存', 'abc第二', 'abc第三']);
  assert.deepEqual(selected.bins[159].samples, ['abc末尾']);
  assert.deepEqual(density(rows, 160).bins[0].samples, ['ＡＢＣ 内存', '其他', 'abc第二']);
});

test('nested phrases with different counts survive and cached results preserve repeated messages',()=>{
  const rows = ['内存价格上涨', '内存价格上涨', '内存价格'].map(text => ({ text, mode: 1, pool: 0 }));
  const result = wordStats(rows, true);
  assert.equal(result.find(item => item.text === '内存价格').count, 3);
  assert.equal(result.find(item => item.text === '内存价格上涨').count, 2);
  assert.strictEqual(wordStats(rows, true), result);
  assert.equal(wordStats(rows).find(item => item.text === '内存').count, 3);
});
