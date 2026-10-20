# Observatory / 观测室

`observatory-preview.mp3` 来自 Rhine Music Demo 的原创程序编配配乐，带首尾淡变，用于 Android 原生播放器中的可选氛围 BGM。配乐无原片采样、无外部录音、无人声，随上游仓库 LICENSE。

上游源谱与合成脚本：`Rhine-Music-Demo/scripts/render-audio.mjs`。Android 安装包只携带这一 MP3，不携带上游 Ogg 声部、试听 WAV 或原片打字采样。Android 界面音效由 `web/src/audio.ts` 合成，打字短音使用本分支的短音与噪声合成。
