# B 站片段下载开源方案调查（2026-10-04）

状态：实现前的调查记录，当时**尚未实现或安装**。后续接入和验证见[分片原型记录](segment-download-prototype.md)；本文保留调查时的判断与未验证事项。没有真实 B 站速度、故障恢复、暂停续传验收结果。调查以官方仓库、官方文档和已读取源码为依据。

## 结论

有专门做时间区间下载的开源项目，但不少只是 yt-dlp 与 FFmpeg 的界面或命令包装。单纯换成这些项目，不能保证下载更快，也不会自然获得真实网络速率与可靠暂停续传。

最值得测试的分片引擎是 **N_m3u8DL-RE**：其点播选段、并发、重试和下载速率能力与目标接近。它不能直接把 B 站网页上的独立音视频直连地址变成时间分片；Bili-Peek 需要先做索引与清单适配。应先证明桥接可行和有实际收益，再决定接入。

## 候选与证据

### N_m3u8DL-RE：优先做受控原型

官方帮助提供点播 `--custom-range 05:00-20:00`、线程数、音视频并发、每分片重试、HTTP 请求超时、分片数量校验。区间选取的是分片边界，精确到用户选区仍需后续裁剪。[官方 README](https://github.com/nilaoda/N_m3u8DL-RE/blob/main/README.md)

其速率列源码每秒读取下载字节计数；单文件下载能按响应长度更新进度。这证明内部有速率与进度数据，不证明存在适合 Node 助手消费的稳定 JSON 事件 API。要另行核实或建立薄适配层，避免把终端颜色和排版当接口。[DownloadSpeedColumn.cs](https://github.com/nilaoda/N_m3u8DL-RE/blob/main/src/N_m3u8DL-RE/Column/DownloadSpeedColumn.cs)

**重要接入限制：**已读 `DASHExtractor2.cs` 的 SegmentBase 分支（214–250 行）未展开 `indexRange` / SIDX；Initialization 无 `sourceURL` 时，添加整个轨道 URL 为一个完整时长的 MediaSegment。仅生成带 SegmentBase 的 MPD，仍可能整轨道下载。SegmentList 分支（251–293 行）支持 `mediaRange`，但按统一 duration 处理分片。桥接应解析真实索引并验证分片时长兼容性，必要时预选范围后生成清单，不能假设任意 SIDX 都能直接映射。初始化段、音视频时基、关键帧余量和时间戳须单独核验。[DASHExtractor2.cs](https://github.com/nilaoda/N_m3u8DL-RE/blob/main/src/N_m3u8DL-RE.Parser/Extractor/DASHExtractor2.cs)

`SimpleDownloader.cs` 将分片的开始/结束字节传入下载流程，并跳过已有最终分片文件。它具备分片复用的基础，但跳过依据是文件存在，助手仍须验证缓存身份与完整性；这不等于内置暂停 RPC。单文件另有 BinaryDownloadManager 路径，不应混同时间区间分片下载。[SimpleDownloader.cs](https://github.com/nilaoda/N_m3u8DL-RE/blob/main/src/N_m3u8DL-RE/Downloader/SimpleDownloader.cs)

本轮未核实可靠的暂停控制 API、跨进程续传保证、签名 URL 更新方式；保留临时目录不等于这些能力已经成立。

### yt-dlp：成熟通用入口，但区间核心仍为 FFmpeg

官方支持 `--download-sections "*05:00-06:00"`，需要 FFmpeg；强制切点关键帧会重新编码并增加耗时。[官方说明](https://github.com/yt-dlp/yt-dlp#download-options)

源码中非零区间起点或区间终点且 FFmpeg 可用时，下载器选择优先返回 `FFmpegFD`，在外部下载器选择之前。因此 `--download-sections` 加 `--downloader aria2c` 不等于对时间片段自动多连接加速。[下载器选择源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/downloader/__init__.py#L82)

FFmpegFD 生成每输入的 `-ss` / `-t`；ExternalFD 的 `real_download` 在进程成功结束时才发完成 hook。不能将通用 `progress_hooks` 或 `--progress-template` 宣称为区间任务持续字节进度。媒体时间推进、输出大小与网络字节是不同指标。[external.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/downloader/external.py)

有 Bilibili 提取器，其 DASH 轨道解析采用视频与音频 `baseUrl` / `base_url`，并非自动提供可选时间分片清单。Bili-Peek 已从页面获得所选画质地址，重复提取不一定有收益，也不能突破本仓库“不读取或导出浏览器 Cookie”的边界。[Bilibili 提取器源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py#L65)

### 专门片段项目：作为流程参考

| 项目 | 已核实的官方说明 | 接入判断 |
| --- | --- | --- |
| [video-clipper](https://github.com/DavidMarsanic/video-clipper) | 用 yt-dlp 提取、FFmpeg 裁剪/封装/编码，源支持时只取选区 | 可参考时间线与缺工具提示；没有证据证明底层比现有 FFmpeg 路径更快 |
| [youtube-clippy](https://github.com/eden-chan/youtube-clippy) | 依赖 yt-dlp 与 FFmpeg，默认输出 H.264/AAC | 小型包装；README 关于“计算精确字节范围”的描述尚未获源码核实，不作为独立索引下载器推荐 |
| [RnJ4/YTClipper](https://github.com/RnJ4/YTClipper) | README 已提示改用 yt-dlp 官方区间下载，并提示流复制切点不精确 | 不适合额外引入；可参考关键帧边界说明 |

包装项目本轮读取了官方 README；部分原始源码目录因访问失败未读到，所以未据此确认线程、恢复和监测实现。

## 建议分阶段接入与测量门槛

以下为设计建议，未实现：

1. **先测当前路径。** 同一视频、同画质、同区间记录网络字节、HTTP Range、首字节等待、下载耗时、转码耗时、CPU、核验耗时和 stderr。网络 Mbps、输出文件增长和编码倍速分别显示。测试长视频中后段的一分钟，不能只测开头。
2. **索引桥接原型。** 保留网页解析与当前画质选择；从允许的媒体 URL 读取初始化段与索引，生成已选区间及必要解码余量的字节范围清单。先验证 RE 不会下载整个轨道、正确响应 206、音视频均完整可解码、选区时长与音画同步符合现有标准。索引缺失应明确失败或提示可选现有路径，不能静默整轨道下载。
3. **单一下载后端对照。** 当前路径与 RE 原型分别跑冷缓存，比较 1、2、4 个并发度；至少覆盖短片段、中段、接近末尾、5–30 分钟选区及不同编码。建议每组交错重复 3 次以上，看中位耗时、尾部延迟、额外下载字节和失败率。只有有一致收益且完整性不退化才替换默认路径；并发越高不保证越快。
4. **故障与控制验收。** 注入断网、连接无数据、错误 Range、签名过期、主/备地址切换、用户暂停、助手重启、磁盘不足。成功分片必须经过完整性确认；暂停后的继续不重复下载已确认分片。明确区分“当前进程暂停”“取消后续传”“助手重启后恢复”，分别验收，不能用一个继续按钮掩盖能力差异。
5. **监测与超时。** 在助手维护任务状态和下载字节计数，对页面输出稳定事件；总量不确定时显示已下载和速率，不伪造百分比。使用连接/读取/停滞限制与有限重试，主动暂停排除于停滞计时；转码与网络阶段独立判断进展。保留取消入口和缓存生命周期，不自动删除用户笔记或已引用附件。
6. **真实安装验收。** 助手源码、已发布浏览器脚本与当前页面分开验证；本地模拟媒体通过不等于真实 B 站通过。最终验收真实网页画质、区间、进度、暂停续传和 Obsidian 成品。

## 尚未验证

- 当前页面是否始终提供可用的 SegmentBase 索引、实际 HTTP Range 行为、签名失效时间与限流。
- RE 对 B 站索引展开清单的兼容性、机器可读进度渠道和任务恢复语义。
- 重编码是否才是当前主要瓶颈；没有网络与编码分阶段计时，无法归因。
- 任何方案在用户实际网络下的提速比例与稳定性。官方功能存在不能代替真实对照测试。
