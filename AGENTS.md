# Bili-Peek 维护说明

Bili-Peek 是用于 Edge / Tampermonkey 的 B 站观看助手：用户脚本 `Bili-Peek.user.js` 负责页面双图、选区和配对，`helper/` 是只监听本机的 Node 片段助手，`.apex/` 是 ControlPod 的模块入口。仓库根不放运行数据。改代码前先读 `README.md`。

## 修改前

- 先看 `git status`，保留已有改动；按当前代码、`package.json` 脚本与测试判断行为，不照抄旧记忆里的命令集合。
- 三个入口各自独立：用户脚本（浏览器侧）、助手（Node 侧）、`.apex/module.json`（ControlPod 侧）。改一处要确认另一处是否受影响。
- `.local/`、`.tools/`、`node_modules/`、`tests/artifacts/`、`tests/export-sandbox/`、`.workbuddy/` 由 `.gitignore` 排除，不进提交。

## 必须保持

1. 助手只监听 `127.0.0.1:18766` 并要求配对码；加载器发布只监听 `127.0.0.1:18767`。两者都不读取或导出浏览器 Cookie。
2. 真实导出失败时保留原因并停止，不制造成功、不生成假转录；缺字幕时保存视频并在笔记注明。
3. 助手离线、未配对、画质读取失败或轨道缺失都要给明确提示与重试，不静默降级、不改写字幕原文。
4. 删除笔记、附件或配对信息前先预览并确认；不清理 Obsidian 中仍有引用的文件。
5. `.tools/ffmpeg.exe` 与 `.tools/ffprobe.exe` 是导出和媒体测试的前提，缺失时用 `python helper/download-tools.py` 重建，不要提交二进制。
6. 浏览器油猴脚本与 Obsidian 阅读插件是独立安装副本；改动它们需要在真实浏览器 / Obsidian 中另行安装与验收。

## 验证

```powershell
npm run check
npm test
```

`npm run check` 是多项 `node --check` 语法检查；`npm test` 是 `tests/` 下的 `node --test` 回归集合。两者具体文件以当前 `package.json` 为准，脚本改成其他形式时应同步更新本说明。

页面渲染与视觉验收用 `npm run preview`（仅监听本机，使用模拟数据，不能替代 B 站真实页面）。导出与媒体测试需要 `.tools/` 下的 FFmpeg / ffprobe。浏览器端到端（真实登录 B 站、油猴安装、Obsidian 阅读链路）必须单独做真实环境验收。
