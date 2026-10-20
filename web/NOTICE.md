# 版权、署名与资源来源

本说明区分代码授权、音乐适配的开发者署名和第三方素材的权利。公开源码不表示放弃版权，也不表示获得全部原作素材的再授权。

## 开发者与上游

| 范围 | 署名与来源 |
| --- | --- |
| 音乐播放器适配及后续修改 | **Copyright (c) 2026 RonaldDeng**。包括本地曲库与播放服务、音乐专辑模型适配、音乐界面、导航、相机交互、文字效果、响应式及版本维护中由本项目新增或修改的部分；不主张对未修改的上游代码或第三方素材享有原创权利。 |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC**。[原仓库](https://github.com/LBEILC/RhineLabUI)，初始基于提交 [`5abab02367465d9189f4ae65bcb6f17fdb5938f7`](https://github.com/LBEILC/RhineLabUI/tree/5abab02367465d9189f4ae65bcb6f17fdb5938f7)。保留其三维档案界面、渲染与动效基础、建模脚本、资料说明和 Git 历史。 |

有权授权的程序代码、建模脚本和技术文档沿用 [MIT License](LICENSE)，保留以上两项署名。分发代码或其重要部分时须一并保留版权声明及完整许可证；适配者的署名不取代上游署名。MIT 允许使用、修改及商业分发，软件按原样提供；本说明不在 MIT 上另加用途限制。具体以许可证原文为准，参见 [MIT 许可说明](https://choosealicense.com/licenses/mit/)。

[README.original.md](README.original.md) 保留上游原说明，其中“本项目”“原创”等措辞归属于该上游文档的语境。RonaldDeng 不代表 LBEILC，音乐适配不表示上游作者参与、认可或为本衍生版本提供支持。

## 原作及非代码资产

视觉参考为《明日方舟》特别映像[「莱茵生命：访问」](https://www.bilibili.com/video/BV1rr4y1b7sz/)。相关作品、名称、标志、设定、视觉设计、原 PV 及其声音的权利归相应权利人所有。本项目是独立爱好者工程，与官方制作方无隶属、赞助或授权合作关系，不主张拥有原作版权或商标。

- `art/*.blend`、`public/assets/*.glb`、界面图标、截图、动图及原作相关演示文本**不因代码采用 MIT 而自动获得原作素材许可**。上游未另行将全部非代码资产声明为 MIT；建模脚本的 MIT 授权也不等于原作相关视觉元素可任意再分发。
- `public/audio/atmosphere.ogg`、`motif.ogg`、`pulse.ogg` 和 `observatory-preview.mp3` 为继承自上游的程序编配，按其[音频说明](public/audio/README.md)随项目采用 LICENSE；不将其重新署名为音乐适配者原创。
- `public/audio/typing-preview.wav` 与 `src/typing-samples.ts` 的三个 38ms 短音来自上述原 PV，来源、时间码及处理记录见 [typing-source.json](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/dd2370fe686979081994a16859143e2adab89839/public/audio/typing-source.json)。**这些采样不属于 MIT 授权范围；来源标注不是原权利人的再分发许可。** 本项目不能为复用者授予相应权利。仅用于本地比对的 `reference/typing-original.wav` 不随本次源码快照和 ZIP 分发；旧 Git 历史未重写。
- [演示封面](public/demo-covers/README.md)是本项目早期音乐适配阶段生成的三张抽象图像，当前文档用它们演示界面，不冒充真实唱片或音乐库。V0.2.0 历史截图由该版本运行画面采集，V0.3.0 界面回归截图使用隔离示例库采集；截图不改变其中字体、模型与原作元素各自的权利。
- 真实歌曲、商业专辑封面、私人曲库索引、缓存和在线介绍不随本仓库及发布包分发。

代码复用者可替换这些资产；使用或再分发涉及第三方权利的内容时，需另行遵守对应许可或取得必要授权。本文件不作“全部资源已获商业授权”的保证。

## 字体与直接依赖

| 组件 | 权利人与许可 | 随包文本 |
| --- | --- | --- |
| MiSans | 小米／Beijing Xiaomi Mobile Software Co., Ltd.，按 MiSans 字体协议随应用原样嵌入；不是 MIT，不将字体作为独立商品或字体包发布 | [署名](public/fonts/NOTICE.txt)、[完整字体协议](public/fonts/MiSans-license.pdf) |
| Three.js | three.js authors，MIT | [three.txt](public/licenses/three.txt) |
| Rolling Number | Kit Langton，MIT | [rolling-number.txt](public/licenses/rolling-number.txt) |
| music-metadata | Borewit，MIT | [music-metadata.txt](public/licenses/music-metadata.txt) |
| OpenCC-JS | nk2028，MIT；所用 OpenCC 字典数据另受 Apache-2.0 约束 | [MIT](public/licenses/opencc-js.txt)、[第三方说明](public/licenses/opencc-js-third-party.md)、[Apache-2.0](public/licenses/apache-2.0.txt) |

这些文本保留依赖包原文。完整版本树见 `package-lock.json`；其他构建工具和间接依赖按安装包各自的 LICENSE / NOTICE 使用，不被本项目重新授权。

## V0.4.0 本机音频依赖

V0.4.0 音频解码通过独立子进程调用用户本机安装的 FFmpeg / ffprobe。FFmpeg 项目的主要许可为 LGPL-2.1-or-later；启用可选 GPL 组件的构建适用其相应 GPL 条款。本次开发机的 FFmpeg 8.0.1 构建启用了 `--enable-gpl --enable-version3`，不将这个构建描述为纯 LGPL。项目没有捆绑、上传或重新授权 FFmpeg 二进制；以后若打包分发，需按实际分发构建保留对应版权、许可证及源代码材料。来源：[FFmpeg 官方](https://ffmpeg.org/)、[官方许可说明](https://ffmpeg.org/legal.html)。

原生输出使用 macOS 自带 AVFoundation / AVFAudio、CoreAudio 与 AudioToolbox 框架，由 Apple 提供；这些系统框架不属于本项目 MIT 代码。`native/RhineAudio.swift` 是本项目新增桥接源码，随项目代码许可；在本机生成的 helper 二进制放在用户数据缓存，不随源码分发。

APE 回归仅在本机临时目录使用 [FFmpeg 官方音频样本](https://samples.ffmpeg.org/A-codecs/lossless/)中的 `luckynight.ape`；它是官方说明所述的一分钟 CD 节选测试样本，来源标注不代表授予音乐再分发许可。文件没有复制进项目，也不进入任何源码包。其他新增音频测试使用现场生成的短正弦波，不使用用户私人曲库。路线与验证详见 [AUDIO-V0.4.0.md](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/dd2370fe686979081994a16859143e2adab89839/docs/AUDIO-V0.4.0.md)。

## 在线资料

Wikipedia 摘要、Wikidata 与 MusicBrainz 数据按其来源许可处理。客户端保存介绍时同时保存来源链接、取得时间和许可说明；此类用户自行查询的缓存不纳入项目 MIT 授权，也不进入发布包。MusicBrainz 将核心数据和补充数据分别授权，详见[官方数据许可](https://musicbrainz.org/doc/About/Data_License)；不能仅因为程序开源就统一将数据改授 MIT。

如发现署名遗漏或具体权利问题，请通过本仓库 [Issues](https://github.com/RonaldDeng/Rhine-Music-Demo/issues) 提供涉及文件、来源及说明，维护者可据此核对。
