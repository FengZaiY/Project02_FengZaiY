# StudySelf 0.1.9 发布验证

日期：2026-10-23。Windows、Node.js 24、Electron 42.11.12、electron-builder 26.15.3；测试使用隔离资料。

## 固定来源

- 版本：0.1.9；分支 main。
- 提交：`640ac9757facf828b2f35361332e4d0893ecd309`，本机与 GitHub main 核对一致。
- 注解标签：`v0.1.9`；标签对象 `a360b7b79f30c9c79866537b1fd8dabdefbb76a5`，远端解引用为上述完整提交。
- 本轮功能与版本合为一次提交，保留并排除 0.1.4、0.1.5、0.1.6、0.1.8 的独立发布交付记录修改。

## 本轮执行结果

- `npm run check:project`、`git diff --check`：通过。
- `npm test`：301 项通过，0 失败、0 取消、0 跳过。
- `test:ui`、`test:agents`、`test:skills`、`test:experience`、`test:asset-previews`、`test:docx-preview`、`test:rich`、`test:storage`、`test:updates`：全部通过。
- 正常桌面权限下 `test:desktop`、`test:exit`、`test:audit-fixes`：全部通过。
- 首次 `npm run dist` 因旧 `release/win-unpacked/resources/app.asar` 被占用失败，未停止旧程序。改用 `npm run dist -- --config.directories.output=release/0.1.9` 完整成功。
- 打包桌面测试使用原 `scripts/test-desktop.mjs` 的机械副本，仅调整 fixtures 导入和打包程序路径至新目录；`node artifacts/test-release-0.1.9-packaged.mjs --packaged` 通过。覆盖 SQLite、安全 IPC、加密、富编辑器、媒体、文件关联、目录选择/取消、迁移保留原件及凭证。
- 查看本轮 Agent、Skill 补全确认和打包程序截图，范围提示、确认清单与内容可读。
- `node artifacts/verify-release-0.1.9.mjs`：142 个构建输入、包内 52 个源码/Skill 文件、316 个快照文件与固定提交一致；包内版本和固定 GitHub 更新源、dist 文件一致。
- `latest.yml` 的大小和 SHA-512、blockmap 解压结构、源码快照及 SHA256SUMS 校验通过。快照通过 git archive 生成，增加 BUILD-PROVENANCE.json，注明固定提交及行尾规范化。

## 附件

产物位于 `release/0.1.9/`，只上传以下五个文件，不上传调试配置、解包目录、数据库或凭证。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| StudySelf-0.1.9-Setup.exe | 114081988 | 91f36ac63ce6bef99e932df4642e89ca20d63d147ee650edb29554b77c3c9dc8 |
| StudySelf-0.1.9-Setup.exe.blockmap | 121020 | 9140b396f3ae087e805add30803a3c4c7d279d572b5024c82444159c80693172 |
| latest.yml | 347 | af9b4b15b8d820e31a97bfe2d863cc5626be8440eee6c7187cd1d0b64db28f21 |
| StudySelf-0.1.9-source.zip | 975112 | f1113186853232da96613cd139dcad22a38019e97da79cc156082088b4c613f5 |
| SHA256SUMS.txt | 363 | 汇总上列四项，远端上传后另行核验自身摘要 |

## 公开与验证边界

Release 草稿：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-d7123e06da6f6cbcbd8b 。

远端读取确认 `isDraft=true`，tagName=v0.1.9，targetCommitish 为上述完整提交，正文与本地完全一致。五个附件均为 uploaded，逐项大小及 GitHub 返回的 SHA-256（包含 SHA256SUMS.txt 自身）与本地一致。证据为 `artifacts/release-0.1.9-github.json` 和对应验证脚本。未经用户明确确认禁止公开；标签及 main 推送不等于 Release 已公开。

实际 Authenticode 检查：安装包及主程序均为 **NotSigned**。真实安装、卸载、跨版本升级、真实双机百度传输未验证。隔离打包程序启动不代替这些验证；未修改正式资料、用户原预览或真实外部 Skill 安装。

日志位于 `artifacts/release-0.1.9-*.log`，完整性证据为 `artifacts/release-0.1.9-integrity.json`。本报告和构建后的交付记录留在工作区，不再改变固定提交或标签。
