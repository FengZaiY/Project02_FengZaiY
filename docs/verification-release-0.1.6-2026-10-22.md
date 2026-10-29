# StudySelf 0.1.6 发布验证

日期：2026-10-22。环境：Windows x64、Node 24.16.0、Electron 42.11.12。

## 固定来源

本地与远端 main 为 `1bb26882c6acda45ed8bc8e62c9c4c142d0821be`。安装包、更新文件、源码快照及 v0.1.6 标签固定对应此提交；交付状态文档留工作区，不自动提交，不改变源码快照。

远端 v0.1.6 附注标签对象为 `65701d4e808e9f94d075232d67813d4a0cdfb6e3`，解析目标已核对为上述提交。

## 本轮验证

- `npm test`：267/267 通过。
- `npm run dist`：安装包、blockmap 和 latest.yml 生成成功，使用 publish never。
- `test:ui`、`test:devices`、`test:skills`、`test:agents`、`test:presentation`、`test:updates` 全部通过。
- `test:desktop`、`test:packaged` 在正常桌面环境通过，测试资料隔离，包含 Skill 安装更新相关 IPC。
- 查看设备管理与 Skill 安装更新的 600 像素窗口截图，操作、状态及底部内容可达，无明显横向溢出。

日志为 `artifacts/release-0.1.6-*.log`。不使用正式知识库、真实外部 Skill 安装或百度客户端。

## 产物完整性

`artifacts/verify-release-0.1.6.mjs` 核对 134 个构建输入、49 个包内核心/桌面/Skill 源文件、运行 package 元数据及全部 dist、固定 GitHub 更新来源、更新版本/大小/SHA512 和 blockmap。

源码 ZIP 从固定提交 git archive 生成，285 个快照文件核对通过，允许 attributes 的 LF/CRLF 转换；另含 BUILD-PROVENANCE.json。四份产物的 SHA256 写入 `release/SHA256SUMS.txt`，结果见 `artifacts/release-0.1.6-integrity.json`。

安装包大小 114072711 字节，SHA256：`87b94ad7352a450a324a2e54089b2c0861cf3e1b71e98451f9ec91df83ef26f9`。

程序与安装包 Authenticode 均为 NotSigned。真实安装、卸载、跨版本升级与真实双机部署本轮未验证；打包程序运行不等于安装验证。

## GitHub 草稿

草稿：`https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-b347d4cedebd8b57f6c7`。

上传后重新读取 GitHub，结果保存在 `artifacts/release-0.1.6-github.json`；isDraft=true、tagName=v0.1.6、targetCommitish 为固定提交，发布说明与上传正文一致。五个附件均 uploaded，远端大小及 SHA256 digest 逐个与本地一致。上传期间首次核对时安装包尚未完成，仅有四附件；等待上传进程成功结束后重载，最终五附件完整核对通过。未公开 Release。

`npm run check:project`、`git diff --check` 通过。正常桌面权限的一次空白检查未带单次 safe.directory，未运行成功；回到原执行环境复核通过，未修改 Git 全局配置。
