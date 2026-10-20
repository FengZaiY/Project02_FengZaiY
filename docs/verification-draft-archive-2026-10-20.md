# 草稿归档与整理闭环验证

日期：2026-10-20。环境：Windows、Node 24.16.0、StudySelf 0.1.1 开发源码。测试使用隔离资料；未生成安装包。

## 实现与边界

- 直接归档校验已保存的草稿基础版本和目标层级，创建正式笔记，保留富正文、附件、出处、标签及敏感标记。原草稿和历史不删除。跨库归档不改变原附件身份或归属。
- 方案项以 `draftRefs` 关联具体草稿版本，用户确认写入 `acceptedVersionId`。正式笔记通过 `draftOrigin` 保留直接归档来源。
- 待处理、部分处理、已处理根据当前来源及有效确认结果派生。完整声明默认关闭；部分提取不会因为所有提交项已确认就变成已处理。完整声明仍须用户审阅，不能视为系统验证了内容没有遗漏。
- 新修改重新待处理，旧结果继续可查；回收、缺失、冲突结果不计为完成。旧方案不自动推测草稿来源。
- 外部 Agent 只能提交关联方案，不能调用受信任归档、确认或状态接口，也不能伪造确认结果。新增字段要求同步电脑更新，原有事件哈希不变。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | 198 通过，0 失败；最终日志 `artifacts/draft-core-final.log` |
| `node --test tests/draft-workflow.test.mjs` | 10 项专项通过，亦包含在全量测试中 |
| `npm run build` | 通过，开发界面构建 |
| `npm run test:drafts` | 通过，最终 UI 防护调整后复跑 |
| `npm run test:ui` | 通过 |
| `npm run test:libraries` | 通过 |
| `npm run test:hierarchy` | 通过 |
| `npm run test:agents` | 通过 |
| `npm run test:assets` | 通过 |
| `npm run test:trash` | 通过 |
| `npm run test:experience` | 通过 |
| `npm run test:desktop` | 首次沙箱内启动失败；沙箱外隔离复测通过，见下文 |
| `npm run check:project` | 通过 |
| Skill `quick_validate.py` | 通过 |
| `git diff --check` | 通过 |

核心覆盖完整富内容和本机投影、重试、过期来源、未保存标签、非法上级、删除来源、部分/完整确认、局部重做、原子回滚、来源新修改、无效结果、回收站依赖保护、权限及历史敏感引用。真实本机 HTTP 测试验证 Agent 可提交方案而不能归档或确认。隔离双目录 v3 测试覆盖同步、重复接收及并发直接归档；不冒充真实双机结果。

界面覆盖取消归档、归档前新输入保存、富正文及表格保留、知识库和旧顶层笔记选择、默认筛选、已处理筛选、搜索、部分再完整确认、新修改回到待处理、重开持久化、过期窗口拒绝写入。检查 1304、1001、600 宽度截图及底部可达、横向溢出。截图位于 `artifacts/ui-draft-workflow/`，包括 `archive-dialog.png`、`partial-1001.png`、`partial-600.png` 和对应结果窗口截图。

## 桌面启动异常

首次执行沙箱内桌面测试遇到 `electronApplication.firstWindow: Target page, context or browser has been closed`，用户截图显示 `electron.exe` 异常 `0x80000003`。原网页预览仍正常，测试进程使用隔离资料，没有证据表明用户数据库受损。

经自动审批允许后，在执行沙箱外设置 `ELECTRON_ENABLE_LOGGING=1` 重跑同一 `npm run test:desktop`。启动、SQLite、安全 IPC、Windows 加密、编辑器、媒体、本地文件绑定、目录选择/取消、重启迁移及源文件保留检查通过，日志为 `artifacts/draft-desktop-diagnostic.log`。没有关闭 Electron 沙箱、上下文隔离或其他安全设置。首次异常内部原因仍未完全定位，不能据此认定已修复某个应用崩溃缺陷。

## 原预览与资料

13895 端口沿用原工作区启动锚点和实际根目录；重启前核对进程及数据位置，刷新前确认没有未保存编辑。前后校验 18 个实体、190 条修改记录、当前分支与 7 个原文件哈希一致，SQLite 检查通过。证据位于 `artifacts/rich-layout/draft-archive-2026-10-20-before.json` 和对应 `after.json`。真实页面只查看既有草稿及新入口，没有执行真实归档或修改正文。

## 未验证范围

未运行安装包构建/验证、真实双机、百度云端传输或真实付费推理。语义覆盖依赖用户审阅 Agent 方案，不自动推断旧方案来源，也不承诺超大草稿库的所有机器性能。来源资料、历史版本及原文件保留，本次不做物理清理。
