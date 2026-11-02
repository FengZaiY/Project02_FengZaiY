# FengZaiY 0.1.19 发布验证

日期：2026-10-30。目标仓库：FengZaiY/Project02_FengZaiY。

## 提交与标签

- 功能及版本合并提交：`bffa624088d1498c634f67f248bb31ba5dff272e`，已推送 main。
- 注解标签：`v0.1.19`；标签对象 `32e223ab82eac0a36170ef564bb8e63acf09fd9d`。
- 远端 main 和标签解引用均为上述固定提交。
- 草稿：https://github.com/FengZaiY/Project02_FengZaiY/releases/tag/untagged-f90e31e31fb0ea2d6d87
- 回读确认 isDraft=true、isPrerelease=false、targetCommitish 为完整固定提交，正文一致。未经用户明确确认不公开。

## 构建与测试

从 git archive 固定提交导出至 `artifacts/r19`，隔离复制依赖，未改构建输入。Electron 42.11.12、Node 24.16.0。通过 dist 构建生成 NSIS 安装包，发布选项为 never。

完整核心 402/402 通过，无失败、跳过或取消；构建、Agent 界面、Skill 界面、通用界面、启动、源码桌面及退出验证均通过。随后串行运行原始 `test-desktop.mjs --packaged` 通过，覆盖包后启动、SQLite、安全 IPC、Windows 加密、编辑器、原生媒体、本机文件绑定、存储选择及重启迁移。

核对 202 个构建输入、77 个包内源码/Skill 文件、68 个界面文件、470 个源码快照文件与固定来源一致，normalizedInputs 为空。最终重建的 68 个 dist 文件与包内逐字节一致。源码 ZIP 含 BUILD-PROVENANCE.json。更新来源为当前仓库；latest.yml 的大小和 SHA512 对应安装包，blockmap 可解析。

查看 Agent 待确认方案和 600 像素窄窗 Skill 文件界面截图，未发现布局异常。

## 发布附件

本机目录：`release/0.1.19`。五附件均回读为 uploaded，远端大小及 SHA256 与本机一致：

| 文件 | 字节 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.19-Setup.exe | 112245557 | 418002e07191d98302ca6e4d92c06e25133446ff4d5d04c6cd9faeffc3305aed |
| FengZaiY-0.1.19-Setup.exe.blockmap | 119216 | e3a9cde3c94643cb1a99c2f83decdda868073973f420ecf67107b3dc4b88e813 |
| latest.yml | 348 | 777ad9b5d145ee566f4a3c6000c0bcc3f5bbddfd657cdf759915ebf633f0e935 |
| FengZaiY-0.1.19-source.zip | 1380662 | 28d7183a563d2a7ce16f3cb4c1b2de10cffac9b12238481017bebafffa9dd944 |

SHA256SUMS.txt 覆盖以上四个文件，其本身亦通过远端摘要比对。证据：`artifacts/release-0.1.19-integrity.json`、`artifacts/release-0.1.19-github.json`、固定树的 `artifacts/release-tests.json` 和各 verification 日志。

## 边界

安装包和程序 Authenticode 均为 NotSigned。真实安装、卸载、跨版本升级、双机联调以及外部模型独立对话选工具稳定性未验证；包后运行不等于真实安装。未操作正式资料、待确认业务请求、已安装应用或受管理 Skill 安装。

保留无关历史文档修改。本报告、计划完成项及状态交付补记不并入固定构建提交，不移动标签或重做附件。
