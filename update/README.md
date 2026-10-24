# update/ · TideVerse 版更新源

`omni-update-tideverse.json` 是万能创作终端（TideVerse 版）检查更新时读取的更新清单（schema `omni-update/1`）。软件读取到比自己新的版本后会提示用户，可以「立即更新」「稍后」或「跳过此版本」，**从不强制更新**。

软件按顺序尝试这三个地址（写在软件的版本配置里），任何一个能读到就行：

1. `https://cdn.jsdelivr.net/gh/ginsonko/tideverse@main/update/omni-update-tideverse.json`
2. `https://ginsonko.github.io/tideverse/update/omni-update-tideverse.json`（由 `.github/workflows/pages.yml` 把本目录的清单一起发布到 Pages）
3. `https://raw.githubusercontent.com/ginsonko/tideverse/main/update/omni-update-tideverse.json`

注意：

- 清单由发布流程根据真实的安装包（版本号、文件名、字节数、SHA256）生成，不要手工编造。
- 下载地址指向 `https://github.com/ginsonko/tideverse/releases/download/v<版本号>/<文件名>`。Windows 用 Setup / Portable 的 exe，Mac 用同名的 `.zip`（网站上给用户的是 `.dmg`，两者是同一个应用）。
- 第一次发布前这里还没有清单，Pages 只发布官网。
