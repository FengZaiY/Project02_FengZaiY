# StudySelf 0.1.8 发布验证

日期：2026-10-22。环境：Windows x64、Node 24.16.0、Electron 42.11.12。

## 固定来源

本地及远端 main 为 `44480c34d0d4bce4c1e90e866554d0fb29b1165f`。发布产物与 v0.1.8 固定对应该提交，继承 0.1.7 的接收目录功能。交付状态文档留工作区，不另行提交或混入源码快照。

远端 v0.1.8 附注标签对象为 `7a15655beb4c73def6ddeaaf7c028047d489d154`，解析目标已核对为上述提交。

## 本轮验证

- `npm test`：284/284 通过。
- `npm run dist`：安装包、blockmap、latest.yml 生成成功，使用 publish never。
- 通用、存储、层级、回收站及更新界面通过；接收目录、修改记录校验两组专项通过。
- 源码桌面、打包桌面在正常桌面环境以隔离资料通过，包含可选字段跨 IPC 后的持久化校验与重启迁移。
- 已查看 `artifacts/ui-revision-integrity/integrity-600.png` 及 `artifacts/ui-received-objects/received-600.png`，文字、操作与错误定位可达，无明显横向溢出。

日志为 `artifacts/release-0.1.8-*.log`。

测试只用隔离资料，不修改正式工作区、配对密钥、真实 Skill 安装或百度客户端。

## 兼容边界

checksum 兼容只适用于已知可选空字段重建后精确匹配原 SHA-256 的记录，不批量重算、不重写事件或跳过校验。未知损坏继续拒绝；尚未取得家里实际异常记录，不宣称修复全部历史问题。两端需更新至包含修复的版本。

## 产物完整性

`artifacts/verify-release-0.1.8.mjs` 核对 140 个构建输入、51 个包内核心/桌面/Skill 文件、运行 package 元数据、全部 dist、固定 GitHub 更新来源、更新版本/大小/SHA512 及 blockmap。

源码 ZIP 从固定提交 git archive 生成，301 个文件核对通过（允许 attributes 的 LF/CRLF 转换），另含 BUILD-PROVENANCE.json。四份文件的 SHA256 写入 `release/SHA256SUMS.txt`；结果见 `artifacts/release-0.1.8-integrity.json`。

安装包大小 114078983 字节，SHA256：`d66eac35ec0fd4edf6919c18b316f93c8ecfe2448fc9a5f2c6728a173118d883`。

程序及安装包 Authenticode 均为 NotSigned。真实安装、卸载、跨版本升级和真实双机部署本轮未验证；打包运行不等于实际安装验证。

## GitHub 草稿

草稿：`https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-7e62002e2e1dfae8f6f2`。

创建使用 draft、verify-tag 和固定 target 参数，五附件全部上传后重载保存为 `artifacts/release-0.1.8-github.json`。确认 isDraft=true、tagName=v0.1.8、targetCommitish 为固定提交，正文与上传说明一致；五个附件均 uploaded，远端大小及 SHA256 digest 逐个匹配本地文件。未公开 Release。

项目检查与 `git diff --check` 通过。交付状态文档留工作区，保留既有旧版记录，不改变固定标签及源码快照。
