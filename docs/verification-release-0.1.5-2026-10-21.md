# StudySelf 0.1.5 发布验证

日期：2026-10-21。Windows x64、Node 24.16.0、Electron 42.11.12。

## 固定来源

安装包、源码快照及 v0.1.5 标签固定为 `6a0c9a62b06931cafb218ad22157253bcd40b0a3`。129 个构建输入与提交逐字节一致。旧版交付记录和本轮后续状态文档留工作区，不混入源码快照，不自动提交。

v0.1.5 附注标签对象为 `1e32f74db437758764e436222c68658759a75906`，远端解析目标为上述提交。此次仅推送标签，远端 main 保持 `a87e565af0a82f0371ce9d69ac848840bb1a3e07`。

## 本轮结果

- `npm test`：251/251 通过。
- `npm run dist`：安装包、blockmap、latest.yml 生成成功，使用 publish never。
- `test:ui`、`test:presentation`、`test:agents`、`test:skills`、`test:updates`、`test:drafts` 通过。
- `test:desktop`、`test:packaged` 在正常桌面环境以隔离资料运行通过。
- 已查看交互图表与 MCP 的 600 像素窗口截图，内容可见，无明显横向溢出。

日志为 `artifacts/release-0.1.5-*.log`。测试不操作正式工作区和百度客户端。

## 产物完整性

`artifacts/verify-release-0.1.5.mjs` 核对 47 个包内核心/桌面/Skill 源文件、运行 package 元数据、全部 dist、固定 GitHub 更新源、更新版本/大小/SHA512 和 blockmap。源码 ZIP 从 git archive 生成，271 个文件核对通过（允许 attributes 的 LF/CRLF 转换），另含 BUILD-PROVENANCE.json。

四份产物的 SHA256 写入 `release/SHA256SUMS.txt`；结果见 `artifacts/release-0.1.5-integrity.json`。

安装包大小 114056085 字节，SHA256：`1a1634f4a9768b4c45da510e13c2631f9b69c16e2b3843c58fa877b49857f8bb`。

安装包与程序 Authenticode 均为 NotSigned。真实安装、卸载、跨版本升级与真实双机部署未验证；打包运行不等于安装验证。

## GitHub 草稿

草稿：`https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-e2851b5a51fd6432be65`。

重载结果保存在 `artifacts/release-0.1.5-github.json`，确认 isDraft=true、tagName=v0.1.5、targetCommitish 为固定提交；五个附件均 uploaded，逐个大小与 GitHub SHA256 digest 均和本地产物相符。未公开 Release。

`npm run check:project` 与 `git diff --check` 通过。发布交付文档留工作区，不改变固定标签、源码快照或提交。
