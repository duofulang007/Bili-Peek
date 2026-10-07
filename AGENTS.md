# Bili-Peek 维护说明

Bili-Peek 是用于 Edge / Tampermonkey 的 B 站观看助手：用户脚本 `Bili-Peek.user.js` 负责页面双图、选区和配对，`helper/` 是只监听本机的 Node 片段助手，`obsidian-plugin/` 提供观看与记笔记工作台，`.apex/` 是 ControlPod 的模块入口。仓库根不放运行数据。改代码前先读 `README.md`。

## 修改前

- 先看 `git status`，保留已有改动；按当前代码、`package.json` 脚本与测试判断行为，不照抄旧记忆里的命令集合。
- 用户脚本、固定加载器、助手、Obsidian 插件与 ControlPod 模块各有独立入口。改动任务或旁文件格式时同时检查发送方、写入方与读取方；业务脚本版本见 `package.json`、脚本头与 `.apex/module.json`，插件版本独立维护在 `obsidian-plugin/manifest.json`。
- `.local/`、`.tools/`、`node_modules/`、`tests/artifacts/`、`tests/export-sandbox/`、`.workbuddy/`、`.workbuddy-ai/` 由 `.gitignore` 排除，不进提交。
- `docs/` 包含历史设计、对照实验与检查记录；`初稿方案.md` 是概念演示。实现以当前源码和测试为准，记录中的安装状态与性能数值不代表本轮验收。
- 用户脚本里的 `module.exports` 分支只在 Node 下走（`typeof document === 'undefined'`），供 `tests/*.test.cjs` 直接 require；改导出名要同步改测试。
- 助手侧「内置并行下载」是默认路径；`config.segmentNative: false` 切到 N_m3u8DL-RE 对照路径，被 `tests/segment-download.test.cjs` 当对照基准用，不要当成死代码删除。

## 必须保持

1. 助手只监听 `127.0.0.1:18766` 并要求配对码；加载器发布只监听 `127.0.0.1:18767`。两者都不读取或导出浏览器 Cookie。
2. 真实导出失败时保留原因并停止，不制造成功、不生成假转录；缺字幕时保存视频并在笔记注明。
3. 助手离线、未配对、画质读取失败或轨道缺失都要给明确提示与重试，不静默降级、不改写字幕原文。
4. 删除笔记、附件或配对信息前先预览并确认；不清理 Obsidian 中仍有引用的文件。
5. `.tools/ffmpeg.exe` 与 `.tools/ffprobe.exe` 是导出和媒体测试的前提，缺失时用 `python helper/download-tools.py` 重建，不要提交二进制。
6. 浏览器油猴脚本与 Obsidian 阅读插件是独立安装副本；改动它们需要在真实浏览器 / Obsidian 中另行安装与验收。
7. 单次选区没有固定时长上限；`helper/export.cjs` 的 `validateTask` 保留合法时间校验，实际源覆盖由分片索引与媒体核验检查。前端按视频范围选择；更改时长规则要同时看前端提示与 README 的「图内操作」，不要把网页弹幕图表的数据保护限制误当成单次截取上限。
8. 分片缓存默认 64 MiB、7 天；活动轨道不得淘汰，超预算使用任务临时目录。测试缓存隔离到 `tests/export-sandbox/`，`npm run clean` 只清理该目录，不动 `.local/` 运行数据。
9. Buzz 只补明确无原字幕的任务，识别失败仍保留已核验的视频和原因；译文、识别稿与原字幕分开保存。NVENC/GPU 路径显式配置，失败不自动换编码器。
10. 工作台按笔记保留独立标签页，仅收拢未修改、未固定的同文件 Markdown 入口；保存个人笔记不得覆盖保存期间的新输入，也不得改写字幕原文。保存目录须在仓库内，设为默认仅在导出成功后更新配置。

## 验证

```powershell
npm run check
npm test
```

`npm run check` 是 `package.json` 指定的多项 `node --check`；`npm test` 运行 `tests/run-tests.cjs`，由它列出 Node 回归集合并在成功或失败后清理测试临时仓库。仅有 Node 时按 `package.json` 执行语法检查，使用 `node tests/run-tests.cjs` 运行回归。

改动 Python 安装器时另跑离线检查（不联网安装工具或模型）：

```powershell
python tests/download-tools.test.py
python tests/install-translation.test.py
```

页面渲染与视觉验收用 `npm run preview`（仅监听本机，使用模拟数据，不能替代 B 站真实页面）；插件模拟页为 `/obsidian-preview.html`，修改插件后用 `node tests/build-player-preview.cjs` 重建。导出与媒体测试需要 `.tools/` 下的 FFmpeg / ffprobe；N_m3u8DL-RE 对照测试缺工具时明确跳过。浏览器端到端（真实登录 B 站、油猴安装、Obsidian 阅读链路）、实际 Buzz 识别与字幕翻译必须单独验收。
