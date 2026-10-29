# 0.1.16 发布验证

日期：2026-10-29。Windows 10，Node v24.16.0，Electron 42.11.12。仓库使用更名后的 FengZaiY/Project02_FengZaiY。仅准备草稿，未经用户本轮明确确认不得公开。

## 固定来源与范围

- 版本 0.1.16；提交 `60b6d396560d30cbc40e41972029718f1b651a1c`，已推送并回读远端 main 一致。
- 注解标签 `v0.1.16`，标签对象 `a38bd0a4964852877240c95400841125d4b2768d`；远端解引用为上述提交。
- 64 个文件合并提交：功能、版本、更新源及文档测试；补齐项目状态既有链接所需历史验证报告。旧版本计划/说明及可读目录补记保留未提交。
- 从固定提交 git archive 导出 `artifacts/r16`；复用同锁文件的真实依赖缓存，未使用依赖目录链接。所有业务写入测试均为隔离数据，不替换正式安装或工作区。

## 本轮执行

- 固定源码项目检查通过；完整 `node --test --test-concurrency=2 tests/*.test.mjs`：394/394 通过，无失败、取消或跳过，约 953 秒。仅给该进程及子进程配置当前源码目录的 Git 信任，不改全局配置。日志 `artifacts/r16/artifacts/core-release-0.1.16.log`。
- 20 项浏览器检查最终通过：通用、启动、标签、删除导航、方案、性能、层级、资料、草稿、可读目录、Agent 请求、Agent、Skill、更新、知识库、回收站、编辑体验、树拖动、DOCX、资料预览。原始结果及每项日志保存在 `artifacts/r16/artifacts/release-0.1.16-browser.json`。
- 6 项源码桌面通过：通用、性能、退出、Agent 操作、更新下载、存储重启保护，见同目录 `release-0.1.16-desktop.json`。
- `npm run dist -- --config.electronDist=node_modules/electron/dist` 完成，只构建、不发布。包后通用桌面和性能专项两项通过；性能副本仅替换启动目标为新包，其附件读取、原件损坏拒绝、真实缩略图及编辑器/撤销断言保留，见 `release-0.1.16-packaged.json`。
- 两项隔离性能基准通过：万条笔记统计 74.9ms、列表 41.2ms、搜索 289.3ms；千条目录首次 136ms、复读 3ms。全文搜索和首次目录仍有成本，不将样本结果推广至所有电脑。
- Skill quick_validate、项目检查和差异空白检查通过。已查看 600px 标签、600px 方案、浏览器及包后真实缩略图截图；无相关布局遮挡或空白素材。

## 首轮失败、复跑与测试前提

保留全部首轮日志，没有把原始 20 项脚本全部记为首轮通过：

1. 层级最终刷新、DOCX 打开原附件超时；原源码脚本串行复跑通过。层级另有仅添加诊断输出的副本通过。不仅凭复跑推断根因。
2. 树拖动原脚本要求刷新后重建编辑器，与本轮“保留未变化编辑器”冲突。临时副本改为等待真实 noteTree 响应并断言当前编辑器未变；过期来源、后续拖动、排序、失败、并发及目录/原件断言保留。第一次适配复跑在更早保存步骤超时，最终串行复跑通过。
3. Agent 脚本普通点击来源后仍要求原方案标签存在；临时副本使用 Ctrl+单击明确新标签，再执行实际来源/确认和权限断言，最终通过。
4. 知识库脚本要求刷新清空已读取附件面板；临时副本在两处使用真实页面重新加载建立冷读，再验证读取失败、重试及迟到响应不跨库，最终通过。

上述三处测试前提适配仅在 `artifacts/r16/scripts/*release-adapter.mjs`，未改变固定提交的源码与原脚本。原测试脚本仍需后续同步这些新交互前提；本次已按相同行为范围验证，不能宣称原脚本全部直接通过。复跑见 `release-0.1.16-retries.json` 与 `release-0.1.16-compatibility.json`。诊断期间仅短暂开启自身隔离测试进程的 localhost Inspector，进程及端口已退出。

## 产物完整性

199 个构建输入、75 个包内源码/Skill 文件、449 个源码快照文件及 68 个前端产物核对通过。输入没有额外行尾差异；包内来源为新仓库，安装标识和 NSIS GUID 沿用。latest.yml 版本、路径、字节数和 SHA512、blockmap 结构已验证。

最终目录：`release/0.1.16`，五附件：

| 文件 | 字节数 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.16-Setup.exe | 112238898 | 51fcefef6a6a1108b487bb605f57e2c30a6e1f864b6a0e8f102868ee1ef68eb4 |
| FengZaiY-0.1.16-Setup.exe.blockmap | 118937 | 7830534d4f76a44946cde2b6be0c4c60bd563f9b9bf8827297377324a7a95e7d |
| latest.yml | 348 | 6cb2019ee7710240f7e3ffd2d70783f6016b0b8dd05a8be86ca25c024d5d116e |
| FengZaiY-0.1.16-source.zip | 1327886 | 6e24e30f0c7c96d13dfb6b14a252894494e319e4c90486074bfe2aee6244c423 |
| SHA256SUMS.txt | 363 | 清单覆盖上述四文件 |

校验证据：`artifacts/release-0.1.16-integrity.json`。源码 ZIP 携带 BUILD-PROVENANCE.json；后续交付文档不追改提交、标签或已生成的源码 ZIP。

## GitHub 与边界

标签已推送；草稿及五附件上传完成。草稿地址：https://github.com/FengZaiY/Project02_FengZaiY/releases/tag/untagged-46893945a4425f074b74 。

GitHub 回读确认 isDraft=true、isPrerelease=false、标签和完整目标提交正确，正文与本机文件一致。五个远端附件均为 uploaded，大小及 SHA256 与本地一致；GitHub latest 仍为 v0.1.15。证据为 `artifacts/release-0.1.16-github.json`，核对脚本 `artifacts/verify-release-0.1.16-github.ps1`。未公开本版；后续交付文档保留工作区，不追改已固定来源。

安装包和主程序 Authenticode 均为 NotSigned。真实安装、卸载、跨版本升级及真实双机百度传输未验证；包后运行、模拟更新和核心双目录测试不等于这些操作完成。没有操作正式业务资料、百度客户端、外部已安装 Skill 或公开 Release。
