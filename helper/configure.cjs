const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = path.resolve(__dirname, '../.local');
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, 'export-config.json');
if (!fs.existsSync(filename)) fs.writeFileSync(filename, JSON.stringify({ vault: 'D:\\Obsidian仓库\\Codex学习', output: 'D:\\Obsidian仓库\\Codex学习\\网页内容', port: 18766, token: crypto.randomBytes(32).toString('hex'), ffmpeg: path.resolve(__dirname, '../.tools/ffmpeg.exe'), ffprobe: path.resolve(__dirname, '../.tools/ffprobe.exe'), category: '视频片段', tags: ['灵感片段', '来源/B站'] }, null, 2));
console.log('本地配置已就绪：' + filename);
