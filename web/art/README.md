# 模型源文件

此目录保留 Blender 场景和对应建模脚本，用于维护与复现。正常运行播放器不需要安装 Blender；运行时资源位于 `public/assets/`。

- `build-music-case.mjs` / `music-case-v040.json`：V0.4.0 新专辑盒的可复现 Three.js 几何源与结构清单。运行 `node art/build-music-case.mjs` 生成 `public/assets/music-case-v040.glb` 并同步带内容哈希的资源入口。本机没有可调用的 Blender 或 Blender MCP，因此本版使用原生几何脚本；没有把旧 `.blend` 冒充新模型源文件。
- `music-cd.blend` / `build_music_cd.py`：保留的 V0.3.0 音乐模式玻璃 CD 盒历史源；V0.3.0 的显示尺寸由前端运行时调整。它不是 V0.4.0 的运行时模型，历史脚本会重写旧资源入口，勿用于重建 V0.4.0。
- `rhine-archive.blend` / `build_archive.py`：保留的原版档案盒。
- `archive-assembly.blend` / `build_assembly.py`：原版拆解模型。
- 其余 `.py` 是共享结构、外壳和审阅场景脚本；生成的 `.blend1` 备份、`.cache/` 和审阅 PNG 不随发布分发。

## 发布前清理保存对话框元数据

Blender 场景可能保存文件选择器的本机目录。V0.1.0 的 `music-cd.blend` 已清空这类固定长度目录字段，并保存为正常的未压缩 `.blend`；模型、材质和场景数据均保持不变。清理证据见 [发布检查](../docs/RELEASE-V0.1.0.md)。

重新生成后，需再次检查源文件元数据。对于本项目已验证的 Blender 5.0.2 / `BLENDER17-01v0502` 文件，可运行：

```sh
python3 scripts/sanitize_blend_browser_metadata.py art/music-cd.blend art/music-cd.clean.blend
```

脚本仅修改 `FileSelectParams.dir` 数组，核对全部其余字节一致后写入新文件，不覆盖输入或已有输出。输入为 Zstandard 压缩文件时另需 `zstd` 命令；已解压文件只需 Python 标准库。其他 Blender 格式会明确拒绝，需要使用对应版本的 Blender 清理后复核，不能直接替换二进制字符串。

本目录非代码资源的许可边界见 [README](../README.md#开发与来源)，不要将代码许可自动扩展到所有模型素材。
