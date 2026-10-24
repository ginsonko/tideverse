# 万能创作终端 · TideVerse 版

把 Codex / Claude Code 变成你的创作引擎的桌面软件：在对话里直接出图、出视频、做漫剧、剪辑和讲题视频。TideVerse 版默认连接 [TideVerse](https://tideverse.cn)，用 TideVerse 账号登录即可开始；也能接其他 OpenAI 兼容站点。可以和其他版本装在同一台电脑上，数据互不影响。

- 官网与下载：https://ginsonko.github.io/tideverse/
- 安装包：见本仓库 [Releases](https://github.com/ginsonko/tideverse/releases)（Windows 安装版 / 免安装版，macOS Apple 芯片 / Intel）
- 交流反馈 QQ 群：1131210592

个人使用免费；公司、学校等机构或大范围商用，请先联系授权合作。

## 使用手册

- [快速上手](docs/快速上手.md) · [使用手册](docs/使用手册.md)

## 仓库内容

| 目录 | 内容 |
| --- | --- |
| `site/` | 官网（纯静态 HTML/CSS/JS，无构建步骤）。下载信息、教程视频、TideVerse 信息都在 `site/config.json` |
| `docs/` | 使用手册 |
| `update/` | 应用内更新清单的发布位置（发布时放入 `omni-update-tideverse.json`） |
| `scripts/` | `check-site.mjs` 站点检查 |
| `.github/workflows/` | `pages.yml` 发布官网和更新清单；`mac-build.yml` 构建 macOS 安装包 |

### 维护官网

```
node scripts/check-site.mjs --sync      # 修改 config.json 后，同步 file:// 预览用的配置副本
node scripts/check-site.mjs             # 违禁字样、链接、config 结构、无头浏览器检查与截图
```

推送到 `main` 且改动了 `site/` 或 `update/` 时，`.github/workflows/pages.yml` 会发布到 GitHub Pages。
