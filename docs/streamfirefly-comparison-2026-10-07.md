# StreamFirefly 与 Bili-Peek 对比

核查日期：2026-10-07（北京时间）。StreamFirefly 正式版 v1.0.4，发布于当日 12:30:15，源码提交 `7eff2af07e9d4f0125d34a1c610474645e4ab3b0`。Bili-Peek 按当前工作目录的 0.3.44 源码核查，保留已有未提交改动。

## 结论

StreamFirefly 的小体积主要来自自编译、裁掉大量能力的 FFmpeg，以及 Rust 助手和浏览器扩展架构；可能较快的保存流程来自并行请求和不重新编码。软件包压缩与视频网络吞吐是不同问题，没有证据表明它靠压缩应用包提升媒体下载速度。

它目前的 B 站保存能力与 Bili-Peek 并不等价：v1.0.4 发布说明表示 B 站 `.m4s` 暂不能直接下载，主要通过播放缓存捕捉保存。不能拿这个流程替换 Bili-Peek 的任意选区直接下载、精确裁剪、原文字幕与 Obsidian 笔记流程。

最值得借鉴的是按实际功能精简媒体工具。多路 Range 和流式写盘，本项目已经实现；整套换成 Rust/curl 不应作为第一步。

## 为什么它的包小

GitHub 发布资产的压缩大小如下，尚未解包测量安装后体积：

| 资产 | 字节 | MiB |
| --- | ---: | ---: |
| Windows x64 完整 ZIP | 5,024,175 | 4.791 |
| Windows ARM64 完整 ZIP | 4,924,171 | 4.696 |
| Chrome/Edge 扩展 ZIP | 669,863 | 0.639 |
| Firefox XPI | 681,654 | 0.650 |

来源：[v1.0.4 发布页](https://github.com/rumoii/streamfirefly/releases/tag/v1.0.4)、[发布资产 API](https://api.github.com/repos/rumoii/streamfirefly/releases/tags/v1.0.4)。不能把 4.791 MiB 的 ZIP 与另一项目解压后的整个目录直接计算缩小比例。

- 使用 Rust 本地助手和 Vue 3 浏览器前端，Windows 网络请求使用系统 curl，没有捆绑 Node 或 Electron 运行时。Bili-Peek 同样复用现有浏览器，没有额外桌面浏览器，也没有 npm 依赖；Node 是外部运行前提，不计入助手源码体积。[README](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/README.md#L91)、[Cargo.toml](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/Cargo.toml)。
- FFmpeg 从 `--disable-everything` 开始，只启用少数媒体组件，启用 `--enable-small`，禁用网络、ffprobe、ffplay、swscale、avdevice 等，静态链接并 strip。没有视频编码器，唯一启用的编码器是 webvtt。[构建脚本](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/tools/ffmpeg/build.sh#L50)。
- 完整包确实包含精简 FFmpeg，以及助手、扩展包和许可文件；不能解释成把 FFmpeg 留到安装后另行下载。[发布打包脚本](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/tools/package-release.ps1#L50)。源码未发现 UPX 或特殊压缩算法。

本机当前只读测量：`ffmpeg.exe` 为 105,423,872 字节，`ffprobe.exe` 为 105,221,120 字节，合计 **200.89 MiB**；`.tools/` 加上用于开发对照的 N_m3u8DL-RE 等共 **213.56 MiB**。`helper/` 源码约 **0.07 MiB**，用户脚本 **111.62 KiB**。这些不包含 Node、浏览器、Obsidian、正式视频附件与 Git 历史。源码压缩不是本项目工具体积的主要优化点。

## 下载与保存方式

| 项目 | StreamFirefly | Bili-Peek 当前实现 |
| --- | --- | --- |
| HTTP 并发 | 默认 6、最多 16 路；支持 Range 时均分范围，多个 curl 请求 | 视频 1–16、音频 1–4；按选区、未缓存字节和分片数量限制 |
| HLS / DASH | 并发切片，DASH 流式拼接使用 64 KiB 缓冲 | 读取 B 站 SIDX，仅取选区和必要前置分片，流式落盘、组装 |
| 同时任务 | 最多 2 个 | 最多 2 个，其他排队；同视频避免缓存写入冲突 |
| 媒体处理 | HLS、DASH、缓存捕捉用 `-c copy` 重封装 | 默认 libx264/AAC 精确裁剪，再做轨道、时长和完整解码核验 |
| B 站路径 | 最新发布说明：以播放缓存捕捉保存为主 | 使用页面已取得的签名地址，直接下载选区所需范围 |
| 备用源 | 本次未核实具有 B 站主备 CDN 竞速 | 最多 3 个同轨道来源，核验内容一致后测速、有限换源 |

StreamFirefly 证据：[并发设置](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/settings.rs#L3)、[HTTP Range 调度](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/http_download.rs#L318)、[Range 支持判断](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/http_download.rs#L518)、[HLS 工作池](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/hls_download.rs#L743)、[DASH 缓冲](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/dash_download.rs#L81)、[HLS copy](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/hls_download.rs#L416)、[DASH copy](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/dash_download.rs#L269)、[缓存合并 copy](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/native-host/src/capture_merge.rs#L115)。

Bili-Peek 证据：`helper/segment-download.cjs:8` 连接规划、`:141` 主备源测速、`:257` 分片流式写入、`:310` 下载工作队列、`:370` 流式组装；`helper/server.cjs:30` 两任务调度；`helper/export.cjs:179` 编码和 `:198` 解码核验。

缓存捕捉从页面首次追加数据开始，不回溯之前的浏览器缓存；需要刷新并从头播放，跳转或编码变化可能分段输出。这与直接保存任意时间区间有不同等待成本。[功能说明](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/README.md#L73)、[版本说明](https://github.com/rumoii/streamfirefly/releases/tag/v1.0.4)。

## 本项目实际慢在哪里

本次读取 `.local/export-timings.jsonl` 最近六条成功日志，没有重新执行网络下载。传输吞吐按 `mediaReceivedBytes / transferSeconds` 计算，不含初始化、测速、组装和转码；日期转换为北京时间。

| 历史任务日期 | 片长 | 下载阶段 | 传输吞吐 MiB/s | 转码 | 完整解码核验 | 总耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10-04 | 604 秒 | 29.87 秒 | 1.10 | 12.17 秒 | 4.92 秒 | 47.02 秒 |
| 10-05 | 199 秒 | 22.03 秒 | 1.43 | 14.57 秒 | 5.47 秒 | 42.11 秒 |
| 10-05 | 392 秒 | 2.65 秒 | 46.46 | 48.52 秒 | 20.36 秒 | 71.82 秒 |
| 10-05 | 92 秒 | 1.33 秒 | 51.31 | 10.50 秒 | 4.29 秒 | 16.18 秒 |
| 10-06 | 41 秒 | 21.23 秒 | 0.38 | 3.61 秒 | 1.07 秒 | 26.16 秒 |
| 10-06 | 30 秒 | 14.81 秒 | 0.18 | 2.83 秒 | 0.84 秒 | 18.53 秒 |

两个快源任务中，转码与核验约占总时间的 95.9% 和 91.4%。两个慢源任务记录中只有一个有效候选来源，不能从日志推断换成 curl 或 Rust 会解决限速，也不能证明域名本身就是唯一原因。

日志中有音频晚于视频完成的情况，也有短任务准备阶段耗时 3 秒以上的情况。下一次优化应分别对照媒体处理、主备地址可用性、音频尾段和准备耗时；不能把所有等待归为下载连接不够。

## 可采用的方案与优先级

1. **降低磁盘体积：按本项目功能裁剪 FFmpeg/ffprobe。** 借鉴它的白名单构建方式，而不是拿它的二进制直接覆盖。必须保留精确裁剪所需 libx264、AAC、实际源编码解码器、MP4 读写、ffprobe 和完整解码核验；本项目会优先 AVC，但仍允许同画质其他编码，不能只保留 H.264。现有媒体测试还用到 lavfi/testsrc2/sine，精简构建需要考虑测试工具的能力。补回这些功能之后的实际体积须构建测量，不能承诺也能做到 5 MiB。保留下载校验、来源及相应许可信息。
2. **降低保存时间和 CPU：先做保持精确选区的媒体处理对照。** `copy` 不解码、不编码，适合整个文件或允许关键帧边界的保存；不能直接替换任意起点的精确裁剪。当前代码已有关键帧实验分支，正式界面只提供精确模式，且已有测试检查不会提前起点。更合适的是先测试硬件编码与现有软件编码的速度、质量、占用和首尾精度，核验继续保留；有收益后再决定采用方式，不直接改默认语义。[FFmpeg 官方 streamcopy 与 seek 说明](https://ffmpeg.org/ffmpeg.html)。
3. **针对慢 CDN：先同源、同编码、同选区冷缓存对照，必要时比较系统 curl。** 多路 Range、续传与磁盘流式处理已有，不需要重新实现。curl 在 StreamFirefly 中会形成多个进程，不是免费减少占用。只有对照证明 Node 请求路径是瓶颈，才值得换掉下载实现。慢任务只有单一候选时，还需核查页面是否本来就只返回一条地址。

其他：`.local/segment-cache/` 目前没有自动容量上限，可以设计可预览的缓存整理来约束长期磁盘增长；这不是本次小体积的主要原因。未删除缓存、配对信息、工具、笔记或附件。

## 占用与证据边界

Rust 助手和不转码使较低运行占用成为合理假设，但本次没有运行 StreamFirefly，没有测其安装后体积、内存、CPU，也没有同条件速度对照。不能报告它比 Bili-Peek 省多少内存或快多少倍。完整 FFmpeg 二进制大小也不等于运行时内存。

本项目默认精确裁剪和全片解码核验是额外工作，它们是保持结果可靠的成本。已有 `docs/download-optimization-0.3.32.md` 的旧本地资源实验显示限制线程可降低编码进程工作集，但这次没有复测，也不能套用为 StreamFirefly 的比较值。

仓库许可为 MIT，FFmpeg 使用独立许可：[项目 LICENSE](https://github.com/rumoii/streamfirefly/blob/7eff2af07e9d4f0125d34a1c610474645e4ab3b0/LICENSE)。本次只保存调查记录，没有修改生产代码、运行安装流程或替换工具，因此没有运行代码回归集合。
