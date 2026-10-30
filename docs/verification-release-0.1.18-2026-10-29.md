# FengZaiY 0.1.18 发布验证

2026-10-29，Windows x64，Node 24.16.0，Electron 42.11.12。仅创建 Release 草稿，未经用户明确确认不公开。

## 固定源码

- 仓库：`FengZaiY/Project02_FengZaiY`。
- 功能及版本合并提交：`63308a225266af56cd4bc8e98163c5a3c2236da0`，已推送 main。
- 注解标签：`v0.1.18`，对象 `f26ee1e5ebfea665604c68c80e8c44416612b7c3`；远端解引用与上述提交一致。
- 范围：Agent 文件导入范围快照、本机重新核对、失效原因、确认冲突及文件恢复后的预览刷新、迟到响应保护；内置 Skill/API/MCP 工具指引与测试；统一版本字段。同步格式未变。
- 历史发布计划/说明及可读目录补记的无关修改保留并排除；状态已有链接所需的 0.1.17 发布报告纳入。交付补记留在本机，不追改固定源码提交、标签及附件。
- 从 git archive 导出到 `artifacts/r18`，依赖从上一固定构建复制为真实目录；没有使用依赖目录链接。

## 本轮验证

- 项目检查、差异检查：通过。
- 固定源码完整核心：401/401，无失败、取消或跳过，363.9 秒。
- 构建及 `npm run dist -- --config.electronDist=node_modules/electron/dist`：成功，使用 publish never。
- 操作审核浏览器及真实 Electron、Agent 界面、Skill 界面、通用界面、启动、源码桌面及退出：通过，使用原脚本，无临时测试前提适配。
- 覆盖独立导入、旧请求本机重新核对、连续三次文件变化后刷新、缺失文件恢复、关闭弹窗迟到响应、最终单独确认、幂等、授权/偏好/过期保护及 MCP 不可重新核对。
- 已查看 600 宽导入变化截图及真实桌面重新核对截图：提示、路径及底部操作可见，预览刷新不自动执行。
- 包后首轮：与核心回归及构建并行时，Playwright `electron.launch` 在 40 秒超时，未进入业务断言；其测试进程已退出。没有足够证据确定具体原因。保留失败日志，待其他检查完成后原脚本单独复跑通过，未改源码、断言或等待时限。
- 包后复跑覆盖 Electron 启动、SQLite、安全 IPC、Windows 加密、富内容/媒体、本机文件绑定、目录选择及隔离迁移。
- 完整性核验：202 构建输入、77 包内源码/Skill 文件、68 界面产物、466 源码快照文件一致，包内更新源为新仓库。最终重新构建后的 68 界面文件也与包内字节一致。latest.yml 大小及 SHA512 与安装包一致，blockmap 可解压解析。源码快照含 BUILD-PROVENANCE.json。

证据：`artifacts/r18/artifacts/release-tests.json`、`verification-*.log`、`installer-build.log`、`ui-agent-operations/*.png`、`desktop-agent-operations/*.png`；首轮包后为 `verification-packaged.log`，复跑为 `verification-packaged-rerun.log`。根目录完整性和 GitHub 回读记录为 `artifacts/release-0.1.18-integrity.json`、`release-0.1.18-github.json`。

## 附件与草稿

本机目录 `release/0.1.18`，五附件远端均为 uploaded，大小和 SHA256 与本机逐项一致，正文、版本及目标已回读。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.18-Setup.exe | 112244876 | b95d6df6dfbba0b756e40e0f7ea2334539118f1b05799e272923beadba283eae |
| FengZaiY-0.1.18-Setup.exe.blockmap | 119212 | 615899077f643f0dcfe02090321a1927eda72584226b013ecb68e27517a6ce30 |
| latest.yml | 348 | e1bd88bf764600bab15dbea5b1c6a8a0cf9059fd05640b40c4686a8f8e188311 |
| FengZaiY-0.1.18-source.zip | 1371413 | daf8a44a412ba26711a679cfd12542f72863e3cf484f4e728133354cfe890def |
| SHA256SUMS.txt | 363 | 清单覆盖以上四文件，清单自身远端摘要也与本机一致 |

草稿：https://github.com/FengZaiY/Project02_FengZaiY/releases/tag/untagged-ca0eaf1da5a76f5fe992

回读 isDraft=true、isPrerelease=false，未公开。核对时旧版 0.1.17 已被其他操作公开，不追改其历史交付证据。

## 未验证范围

安装包及主程序 Authenticode 状态均为 NotSigned。真实安装、卸载、跨版本升级和真实双机传输未运行；本轮没有重做外部模型独立对话的自主选工具验证。隔离 SDK/MCP、浏览器和桌面检查不代替上述实测。正式资料、真实待确认导入、已有更新缓存和安装程序未改动；已安装旧版本须升级才包含本轮源码修复。
