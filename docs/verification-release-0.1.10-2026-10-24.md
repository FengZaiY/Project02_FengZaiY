# StudySelf 0.1.10 发布验证

日期：2026-10-24。Windows、Node.js 24.16.0、Electron 42.11.12、electron-builder 26.15.3；全部测试使用隔离资料。

## 固定来源与范围

提交 `2bb6d3c9b7c047d64bb1ee2cfebfbba083518403` 已推送 GitHub main 并核对远端完整提交一致。功能和版本合为一次提交，包括同步清单占用重试、已确认整理方案清理和草稿确认依据保护，以及相关测试、Skill 协议和文档。旧版独立交付记录修改保留且排除。

版本统一为 0.1.10，依赖不变。构建使用 release/0.1.10 专属目录，不覆盖旧版解包程序。

## 本轮测试

- `npm test`：312 项通过，0 失败、取消、跳过；包含 Windows 真实句柄占用释放重试及方案回收、恢复、永久清空与远端删除依赖保护。
- `test:ui`、`test:sync-publication`、`test:drafts`、`test:trash`、`test:libraries`、`test:assets`、`test:agents`、`test:storage`、`test:hierarchy`、`test:skills`、`test:updates`：全部通过。
- `test:desktop`：前两次在 Electron 启动阶段超时。待核心及界面测试结束后，相同命令正常权限隔离重跑通过，包含安全 IPC、加密、媒体、文件关联、目录迁移、原件及凭证保留。未修改超时或降低沙箱。
- 查看本轮 `artifacts/sync-publication-ui/blocked-600.png` 和 `artifacts/ui-draft-workflow/proposal-cleanup-confirm.png`，窄窗口处理提示和清理确认文字可读，按钮可达。
- 项目检查与 `git diff --check` 通过；最终交付前再次检查。

## 构建进度

首次受限构建长时间停在 Electron 下载后的阶段，目录仍空；核对命令行后只结束本轮构建进程。正常权限重试仍停在获取运行时阶段，随后仅结束该构建进程。未结束正式应用或百度客户端。

本机 node_modules/electron 的包版本与 dist/version 均为 42.11.12，与锁定依赖和 builder 版本一致，源码桌面测试已使用该发行文件通过。改用：

```text
npm run dist -- --config.directories.output=release/0.1.10 --config.electronDist=node_modules/electron/dist
```

命令仍为 --publish never，不改变发布来源或依赖。最终构建完整成功。

## 打包与完整性

- `node artifacts/test-release-0.1.10-packaged.mjs --packaged` 通过。该脚本为原 scripts/test-desktop.mjs 的机械副本，仅修改产物路径和 fixtures 相对导入；覆盖 SQLite、安全 IPC、Windows 加密、富编辑器、原生媒体、文件绑定、存储选择/取消、迁移及原件/凭证保留。
- `node artifacts/verify-release-0.1.10.mjs` 通过：144 个构建输入、包内 53 个源码/Skill 文件、325 个源码快照文件与固定提交一致；dist 字节、包内版本和固定 GitHub 更新源一致。
- latest.yml 的文件大小及 SHA-512 一致；blockmap 可解压解析。源码快照由 git archive 生成，增加 BUILD-PROVENANCE.json，标注固定提交及行尾规范化；SHA256SUMS.txt 覆盖安装包、blockmap、latest.yml、源码快照。
- Authenticode 实测安装包与主程序均为 **NotSigned**。
- 已创建并推送注解标签 v0.1.10，标签对象 `083513f09369ea6d744f00fcd527fa36796b6660`，远端解引用为 `2bb6d3c9b7c047d64bb1ee2cfebfbba083518403`。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| StudySelf-0.1.10-Setup.exe | 114167959 | 7b6c477ee2e339a8864c6f909ef0ae6f7497ba73f1907278b179ecc6c376c507 |
| StudySelf-0.1.10-Setup.exe.blockmap | 120533 | 6dec0adc1f4d7687463a7a2e2a753a254e5fb4c9f702e4a844593a4dc5ce3ee6 |
| latest.yml | 350 | 70d92d7a4da1c8cd3fccadbe690de7981f130671968ce6a853509347e0faf54f |
| StudySelf-0.1.10-source.zip | 995145 | 28dee61c7518054990faec65191bffa5f10c41ea8684cd01b9e88a77892eda12 |
| SHA256SUMS.txt | 汇总四项 | 上传后另行核对自身摘要 |

GitHub 草稿：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-718f8459c19062671c62 。

上传完成后通过 gh release view 重载确认 isDraft=true、tagName=v0.1.10、targetCommitish 为上述完整提交。五个附件均 uploaded，远端字节大小及 GitHub 返回的 SHA-256 逐项与本地一致（包括 SHA256SUMS.txt 自身）；正文与本地发布说明文件一致。证据：artifacts/release-0.1.10-github.json 及 verify-release-0.1.10-github.ps1。未执行公开操作。

打包程序截图 artifacts/desktop/packaged-window.png 已查看，显示版本 0.1.10，编辑器与原生图片正常呈现。完整性证据为 artifacts/release-0.1.10-integrity.json，安装包与五附件保存在 release/0.1.10/。

## 边界

未操作正式知识库、原预览、真实 Skill 安装或百度目录。真实安装、卸载、跨版本升级及真实双机百度传输未验证；隔离打包程序测试不能代替。未经用户明确确认不公开 Release。

日志位于 artifacts/release-0.1.10-*.log。构建后的本地交付记录不再次提交，不改变固定构建来源和标签。
