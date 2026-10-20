<p align="center">
  <img src="docs/assets/rhinedroid-logo.svg" width="480" alt="RhineDroid Logo" />
</p>

<h1 align="center">RhineDroid</h1>

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Android-3DDC84?style=flat-square&amp;logo=android&amp;logoColor=black" alt="Android" />
  <img src="https://img.shields.io/badge/Kotlin-7F52FF?style=flat-square&amp;logo=kotlin&amp;logoColor=white" alt="Kotlin" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vulkan-AC162C?style=flat-square&amp;logo=vulkan&amp;logoColor=white" alt="Vulkan" />
  <img src="https://img.shields.io/badge/Filament-087F8C?style=flat-square" alt="Filament" />
  <img src="https://img.shields.io/badge/AndroidX%20Media3-4285F4?style=flat-square" alt="AndroidX Media3" />
</p>

RhineDroid 是 [Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) 的 Android 移植分支，在手机上以三维专辑架浏览和播放本地音乐。界面设计源自 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)，本分支独立维护 Android 适配。

移植基于上游 **v0.4.1**，对应提交 [`dd2370f`](https://github.com/RonaldDeng/Rhine-Music-Demo/commit/dd2370fe686979081994a16859143e2adab89839)。相较于面向 macOS 的主线，本项目采用 Kotlin 应用容器、Filament / Vulkan 原生专辑架渲染与 AndroidX Media3 播放，并适配 Android 曲库访问、后台播放和横竖屏操作。

本项目由 [IssacL04](https://github.com/IssacL04) 独立维护，属于非官方衍生版本。安装包见 [v0.4.8-Alpha](https://github.com/IssacL04/RhineDroid/releases/tag/v0.4.8-Alpha)，问题与建议请提交到 [RhineDroid Issues](https://github.com/IssacL04/RhineDroid/issues)，由本项目维护者处理。

## 已实现功能

| 功能 | 说明 |
| --- | --- |
| 三维专辑架 | Filament / Vulkan 原生 GPU 渲染，包含亚克力盒体、透明内页、页脊与顶部高光、焦点外渐变模糊，以及开场波浪动画。支持滑动浏览、专辑抽出与归位、缩略图总览。 |
| 本地曲库 | 扫描系统媒体库，或通过系统文件选择器添加音乐文件夹；读取音频标签和封面，缓存索引并复用未改变文件的扫描结果。 |
| 搜索与整理 | 搜索专辑和歌曲并定位到专辑架；按流派、歌手或专辑排列，支持调整本地流派分类。 |
| 音乐播放 | 通过 AndroidX Media3 播放 FLAC、MP3、M4A 等常用格式；支持专辑队列、上一首 / 下一首、进度与音量调节，以及歌曲切换时的淡变设置。 |
| 后台与设备控制 | 后台播放、通知栏与锁屏控制、系统音频焦点管理，以及偏好音频输出设备选择。实际输出路由由 Android 决定。 |
| 界面与动效 | 横屏沉浸布局和竖屏布局、方向切换动画、暖昼与深夜主题、可展开和收起的播放卡片，以及独立可调的界面音效与氛围音乐。 |
| 专辑资料 | 按需查询专辑简介、流派和制作人员，缓存查询结果并保留来源；本地播放不依赖这些在线服务。 |
| 问题反馈 | 在应用内导出运行日志 ZIP，包含设备信息、渲染状态和近期错误，便于排查真机问题。 |

## 使用

需要 Android 8.0 及以上，设备须支持 Vulkan 1.1。项目仍在测试阶段，音频格式的实际支持范围取决于设备解码能力。

已完成本地 APK 构建、单元测试、Android Lint 与多尺寸界面回归检查，并依据真机反馈修复交互问题。Alpha 版本尚未完成广泛设备兼容性验证；在线专辑资料服务也可能受来源限流影响。当前公开安装包使用调试签名。

应用 ID 为 `com.enc3l.rhinedroid`，RC 版为 `com.enc3l.rhinedroid.rc`。与旧包名版本分别安装，旧版的设置和曲库索引不会自动迁移；首次使用需重新授权并扫描音乐。

1. 安装 APK，进入「音乐库」，授权扫描设备音乐，或添加音乐文件夹。系统媒体库扫描适合已被 Android 收录的大规模曲库；文件夹首次导入需要额外读取标签。
2. 在专辑架中滑动选取专辑，或通过搜索定位歌曲。打开专辑，点击曲目即可播放。
3. 点击顶部歌曲名展开播放卡片，调节进度和音量；点击卡片内的歌曲信息收起。
4. 在设置中切换主题、调整音效或查询专辑资料。移除已添加文件夹只解除授权并移除索引，不删除音乐文件。

本地扫描和播放可离线使用。在线专辑资料按需开启，音乐文件保留在设备上。

## 本地编译

### 准备环境

| 工具 | 要求 |
| --- | --- |
| JDK | 17，`JAVA_HOME` 指向对应的 JDK 目录。 |
| Node.js | 22.12.0 或更新版本，包含 npm。 |
| Android SDK | Platform 37、Build Tools 36.0.0 和 Platform Tools，可通过 Android Studio 的 SDK Manager 安装。 |
| Bash | 4 或更新版本；Windows 建议使用 WSL2，macOS 需另行安装新版 Bash。 |

将 `ANDROID_HOME` 指向 Android SDK 目录，或在项目根目录创建 `local.properties`，填写 `sdk.dir=/你的/Android/SDK/路径`。把 SDK 的 `platform-tools` 目录加入 `PATH` 后即可使用 `adb`。项目自带 Gradle Wrapper，无需单独安装 Gradle；首次构建需要联网下载依赖。

### 构建与安装

克隆或下载项目后，在包含 `gradlew` 的项目根目录执行：

```bash
bash scripts/build-apk.sh
```

脚本会安装 Web 依赖、运行相关检查与原生单元测试，再编译 APK 并运行 Android Lint。Web 资源和专辑架网格由 Gradle 自动构建，无需手动复制。

当前版本输出为 `deliverables/RhineDroid-v0.4.8-debug.apk`。连接并授权 USB 调试设备后，可安装到手机：

```bash
adb install -r deliverables/RhineDroid-v0.4.8-debug.apk
```

实验性光学效果版本使用 `bash scripts/build-apk.sh rc`，输出为 `deliverables/RhineDroid-v0.4.8-rc.apk`，使用独立包名，可与普通版本共存。两种构建都使用本地调试签名；覆盖安装已有版本时，签名必须一致。

也可以安装 Web 依赖后，直接使用 Gradle 编译：

```bash
npm ci --prefix web
npm run check --prefix web
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

此方式的 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 反馈

请在本仓库 Issues 中说明手机型号、系统版本和复现步骤。运行日志可从「设置 → 诊断与日志 → 导出运行日志 ZIP」保存；日志可能包含文件名，公开分享前请检查内容。

## 来源与许可

感谢 [RonaldDeng / Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) 提供音乐播放器设计与交互，以及 [LBEILC / RhineLabUI](https://github.com/LBEILC/RhineLabUI) 提供原始三维界面与动效基础。

程序代码沿用 [MIT License](LICENSE)，保留原有版权声明。Logo、字体、第三方依赖和原作素材的来源与权利说明见 [NOTICE.md](NOTICE.md)。RhineDroid 是非官方衍生项目。
