# Bili23 下载实现与可借鉴点

研究日期：2026-10-04。固定上游提交：`e3d6aff32fffca88b249412b92b40448321418c4`（本次 `git ls-remote ... HEAD` 返回值）。只读取官方源码，未安装、执行上游程序，未读取本机 Cookie。下述资源占用分析是代码推断，没有同机同视频性能对照。

## 核心结论

Bili23 当前实现是 **Python + httpx + Qt 线程池的自研 HTTP Range 下载器**，并非 N_m3u8DL-RE 或 aria2。每个文件分成 4 MiB 字节块，默认四线程；8 KiB 逐批读取并直接写入同一个文件的对应偏移，避免把完整视频装入应用内存。这种架构为低下载阶段占用提供了合理解释，但不能据此断言它在用户机器上一定比 Bili-Peek 更省资源。[线程池及块大小](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L459-L475)、[Range 与流式写入](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L280-L361)。

| 项目 | 固定提交实现 | 证据 |
| --- | --- | --- |
| 线程与任务数 | 每任务线程默认 4，范围 1–10；同时任务默认 1，范围 1–10 | [config.py L355–366](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/common/config.py#L355-L366) |
| 下载块 / 读取缓冲 | 每 HTTP Range 块 4 MiB；每次迭代读取 8192 字节，写满 1 MiB flush 并推进断点 | [块大小](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L475)、[flush 参数](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L78-L85)、[读取写入](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L321-L361) |
| 文件输出 | 每工作线程打开同一文件 `r+b`，seek 到自己的字节块偏移；可预分配文件，默认开启 | [写入偏移](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L290-L296)、[预分配入口](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L1558-L1571)、[默认配置](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/common/config.py#L351) |
| 超时与局部重试 | stream GET `timeout=10`，这是 httpx 请求操作超时配置，不是整个任务十秒；块最多五次错误尝试，秒级退避封顶 8 秒；有进展续传另设最多 20 轮 | [请求超时](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L251-L296)、[退避](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L426-L447) |
| 局部断点 | 从已经确认写入的字节继续 Range，不要求整个 4 MiB 块重新下载；关闭/flush 成功才提交偏移 | [断点加载](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L215-L282)、[关闭后提交及短响应续传](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L363-L399) |
| 任务级恢复 | 默认开启，默认最多五次，30→60→120→240→300 秒退避，仅网络可重试错误；中间实际下载量变化会重置配额 | [配置](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/common/config.py#L362-L366)、[策略](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L644-L678) |
| 进度更新 | 一秒定时采样按实际时间计算速度，发一次 GUI / 任务存储更新；不是每个 8 KiB 都刷新界面 | [定时器](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L515-L517)、[采样](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L1338-L1363) |

## 连接复用与 CDN

下载线程共享一个 `httpx.Client`，SSLContext 全局复用；没有打开 `http2=True`，不能把提速归因于 HTTP/2。**注意一个源码细节**：下载器将 limits 传给 Client，却同时显式传入 HTTPTransport；上游自己在 request.py 注释说明这种写法不会把 Client 的 limits 传进 transport。因此可以确认线程池限制实际工作线程数，不能声称下载连接池严格受该 limits 限制。探测客户端则正确把 limits 传给 transport（64 总连接 / 16 keepalive）；走代理时挂载 transport 另有参数。[下载会话](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L1210-L1235)、[limits 注释与公共池](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/request.py#L24-L46)、[探测池](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/download_url.py#L38-L80)。

CDN 策略包括：过滤部分 PCDN/MCDN 主机；将接口原始 URL 改写成用户配置的国内/海外镜像主机；保留原始调度地址兜底；跨任务共享主机失败计数，连续两次失败后 180 秒降权。过滤后为空会退回原始地址，不保证任何视频都有可用普通镜像。[候选生成](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/cdn.py#L70-L120)、[过滤与改写](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/cdn.py#L122-L195)、[健康状态](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/cdn.py#L13-L68)。

候选探测四并发，单操作超时五秒，不在同一个节点重复探测；采用滑动窗口，先得到有效文件大小的候选即返回，同一完成批次遵循候选顺序。探测是 HEAD，必要时 `Range: bytes=0-0` 取文件大小，**不是下载一大段比较带宽**，因此不能称“自动选出持续带宽最高节点”。[参数](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/download_url.py#L15-L32)、[返回策略](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/download_url.py#L151-L224)、[HEAD / 1 字节 Range](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/network/download_url.py#L229-L275)。

## 为什么合并可能占用很低

音视频合并使用 FFmpeg `-c:v copy -c:a copy`，只是重新封装，通常避免视频编码负担。GUI 是 PySide6 + Fluent Widgets，不是网页容器。两者都有可能减少相应阶段占用，但没有测到它的实际 CPU/内存，也不能将其整段下载+无损合并与 Bili-Peek 的任意起止时间精确裁剪直接比较。[合并](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/ffmpeg/command.py#L97-L124)、[依赖](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/requirements.txt#L1-L7)。

所查下载器按完整文件大小切字节块，按文件队列依次安排轨道，并非 SIDX 时间选区下载。扫描固定归档所有 `src/**/*.py` 未发现 FFmpeg `-ss/-t/-to` 区间命令，`sidx` 只出现在音频容器说明；这限定于本次提交，不能推断未来版本。音视频流选择和 concat 多 part 不等于任意时间段精确截取。[文件队列](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L836-L906)、[块计算](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/download/downloader/downloader.py#L1011-L1047)、[命令构造](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/src/util/ffmpeg/command.py#L84-L183)。

## Bili-Peek 优先级建议

这些是待验证建议，未在本次研究里修改实现。

1. **先测占用属于下载器、Node 中转，还是 FFmpeg 精确重编码。** 以同清晰度、同编码、冷缓存、同区间分别记录下载和媒体处理阶段 CPU / 工作集 / 请求空档。若高占用发生在下载之后，增加下载线程不解决它。
2. **优先借鉴进度通知节流与有界流式输出。** 本地中转维持背压，按固定频率发布进度；检查网络块→缓存→本地 HTTP→NRE 临时文件→拼接的复制、落盘与缓冲。并非直接把 Bili23 的 8 KiB 值照搬给 Node；需测不同缓冲大小和复制次数。
3. **其次评估片内续传。** 网络抖动或暂停时保留已经验证的字节偏移，避免整媒体分片重新下载；需要严格检查源身份、206 / Content-Range、一致性和落盘确认。不能为速度去掉现有 SHA 校验与源一致性保护。
4. **再评估直接 Range 调度减少外部引擎中转。** 保留 SIDX 选区与缓存、暂停/重试语义，仅替换下载调度。自研会增加维护成本，先做小范围同条件对照，证明 CPU / 内存 / 耗时收益后决定。
5. **跨任务 CDN 健康状态和轻量探测可试。** 可缓存主机短期健康与性能历史，减少每次全候选大样本测速。仍以接口给出的同轨道地址为基础；Bili23 的任意镜像主机改写不能直接采用，需解决鉴权、内容一致与安全白名单。
6. **整段 copy 可作为独立速度选项，不能默默代替精确裁剪。** 若允许关键帧附近起点，copy 可以避免编码负担；要求原指定帧起止则不能仅靠 copy 达到同一效果。保持清晰提示和既有精确性测试。

源码没有证明“线程越多越快”，也没有可用于承诺固定提速或固定低占用的实测基线。默认四线程已经与现有视频四连接接近，优先减少重复工作和断点损失，再按真实 CDN 带宽验证并发调节。

## 本地对照补充（主调查提供，未改运行实现）

主调查采样时，活动任务附近的唯一 FFmpeg 约 886.2 MiB 工作集、92 个进程线程，三秒内累计 CPU 时间 39.688 秒；Node 助手约 70 MiB 且 CPU 低。但该 FFmpeg 随后退出，未取得父进程链，因此这是任务时间上的关联，不能写成已经严格归属到该任务。

为核实自动编码线程的开销，主调查使用本地生成 1080P / 30fps / 12 秒（360 帧）输入、libx264 veryfast / CRF20，按 auto、4、4、auto 交错编码。原始记录：[results.json](../.local/media-resource-probe/results.json)。本研究实际读取了该记录。

| 编码线程设置 | 两次耗时 | 峰值工作集 | 峰值进程线程数 |
| --- | --- | --- | --- |
| 自动 | 0.815 / 0.874 秒 | 670.7 / 670.6 MiB | 72 |
| 4 | 1.920 / 1.938 秒 | 295.2 / 295.0 MiB | 32 |

主调查确认四份输出时长、分辨率、360 帧和完整解码检查均通过。文件大小不同，未证明位级相同。**限制编码线程减少了资源峰值，但耗时增加**；此处只测试编码，不是完整片段导出性能，更不是 Bili23 与 Bili-Peek 的对照。不能据此承诺限线程会加快下载或整段流程。

主调查还读取了真实 0.3.31 完成任务 `d236` 的阶段记录：124,417,589 下载字节，下载阶段 72.08 秒，视频轨道 52.11 秒、音频轨道 66.38 秒；准备 5.54 秒、传输 66.38 秒、拼接 0.16 秒，最多五个请求并发，无数据空档记录为零。媒体处理 32.58 秒，核验 5.61 秒，总计 110.37 秒；轨道仅一个 CDN 候选。这组数据是单任务观察，未重复对照，但说明**音频单连接可能成为尾段等待来源**，不能把所有波动都归为视频 CDN。

相应建议补充：在既有总并发预算内，对音频持续吞吐不足时从一个请求调整到两个请求进行小范围实测；若切片很短则保留单连接，避免请求开销超过收益。优先用同任务的轨道时间和剩余量触发，保留取消、暂停与重试一致性。此建议尚未实现。
