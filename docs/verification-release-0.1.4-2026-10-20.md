# StudySelf 0.1.4 发布验证

日期：2026-10-20。环境：Windows x64、Node 24.16.0、Electron 42.11.12。

## 固定来源

本轮起点工作区干净，本地与远端 main 为 `a87e565af0a82f0371ce9d69ac848840bb1a3e07`。安装包、源码快照与 v0.1.4 标签固定对应该提交。后续发布说明、计划和状态文档更新留工作树，不改变发布目标，不自动再提交。

## 本轮验证

- `npm test`：236 项全部通过。
- `npm run dist`：安装包、blockmap 和 latest.yml 生成成功，使用 publish never。
- 通用、回收站、知识库、资料、Agent、Skill、存储、更新界面回归通过。
- `test:exit`、`test:desktop`、`test:packaged`、`test:document` 通过。
- `test:editor` 首次在第 137 行短按拖动检查失败，页面脚本错误为空；单独复跑通过，未修改代码或测试。首次日志 `artifacts/release-0.1.4-editor.log`，复跑 `artifacts/release-0.1.4-editor-retry.log`，不把疑似负载/时序因素记为已证实根因。
- 已查看本轮 `artifacts/exit-ui/pending.png` 与 `artifacts/trash-ui/directories-600.png`，退出保存及窄窗口清理确认内容、按钮可见，无明显重叠。

测试资料均隔离于 artifacts，不修改正式工作区或百度客户端。其余日志为 `artifacts/release-0.1.4-*.log`。

## 产物完整性

`artifacts/verify-release-0.1.4.mjs` 比较包内 44 个核心/桌面/Skill 文件与固定提交、运行 package 元数据及全部 dist 字节；校验更新来源、feed 版本/大小/SHA512 和 blockmap 可解析性。

源码 ZIP 从固定提交 git archive 生成，额外加入 BUILD-PROVENANCE.json；交付状态文档不回填此快照。四个文件 SHA256 记录于 `release/SHA256SUMS.txt`，详细结果为 `artifacts/release-0.1.4-integrity.json`。

251 个快照文件均核对内容；Git 按 attributes/core.autocrlf 导出时，`.editorconfig`、`.gitattributes`、`.gitignore` 和 `src/preview/directory-picker.ps1` 与原始 Git blob 仅存在 LF/CRLF 差异，其余字节一致。未因核对重建或替换已上传的源码快照。

安装包大小 109750031 字节，SHA256 `8dadc696a68dfd538b444f4c35278bad1c5ed7c672202f8d05c34415159b7a20`。安装包与程序 Authenticode 均为 NotSigned。

## 发布与边界

v0.1.4 附注标签已创建并推送，标签对象为 `4a162cfb2bd658b1043956ef32cad1d352f5cb55`，解析目标为 `a87e565af0a82f0371ce9d69ac848840bb1a3e07`，与远端 main 一致。

草稿已保存，五个附件上传齐备，重新加载确认既有标签、未公开提示、完整附件名、固定提交号及安装包 SHA256。地址为 `https://github.com/FengZaiY/Project02_StudySelf/releases/edit/untagged-f0dc4516ac373c3b900f`，截图 `artifacts/release-0.1.4-github-draft.png`。未点击 Publish release。

旧页面文件选择器两次超时，保存草稿后新页面上传成功；保存按钮的一次操作回传超时，重载后已确认最终说明及五个附件持久化。最终 `check:project`、版本/源码快照与哈希核对、`git diff --check` 通过。

真实安装、卸载、跨版本安装升级、双机部署未验证；打包桌面运行不能替代这些证据。未运行与本轮改动无关的所有富内容专项或性能基准。
