# 仅 MCP 接入与统一知识权限验证

日期：2026-10-23。环境：Windows、Node.js 24.16.0、源码版本 0.1.8。测试使用 `artifacts/` 下隔离工作区；已有发布文档、Skill 安装修复和剪贴板改动保留。

## 范围

- 外部连接仅保留 `/mcp`，旧 `/v1/rpc` 返回 404。界面合并为一个 MCP 开关和配置区域。
- 按用户明确确认，有效凭证覆盖全部当前及后续知识库、敏感资料和现有 read/collect/propose/edit/trash 工具。保留有效期、独立凭证、Host/Origin 校验、基础版本、偏好校验及幂等。
- 确认方案入库、永久删除、系统/设备/授权管理仍不提供 MCP 工具，不提供任意 RPC 或本机路径访问。
- 撤销事务删除对应授权、访问记录和请求回执，失败整体回滚；旧撤销项在启动清理，知识不删除。旧活动凭证升级范围，哈希和有效期不变。
- 分发 Skill 脚本改用 MCP 初始化、工具发现及调用；无 RPC 回退，不自动重试写入。现有脚本副本需更新。

## 验证

构建、`npm run test:agents`、`npm run test:skills`、`npm run test:ui` 及项目检查通过。Skill 元数据使用 `python -X utf8` 运行 skill-creator 的 `quick_validate.py` 通过。

Agent 界面测试覆盖连接开关、无逐库/额外权限选择、SDK 与分发脚本写入、部分确认、偏好与 Skill 导出、复制失败兜底、撤销删除及旧凭证失效；无 pageerror。检查 1480、1165、600 宽度及底部可达截图，包括 `artifacts/ui-agents/agents-1165.png`、`agents-bottom-600.png`；结果见同目录 `report.json`。

全量 `npm test` 已运行，但部分隔离测试子进程超过半小时未完成，终止本轮该进程树，不能记为全量通过。运行中发现撤销回滚测试的模拟函数把只读调用误作 setter，已修正转发参数方式，单项重跑通过；产品实现未以跳过断言规避问题。

`npm run test:desktop` 及正常权限下隔离重试均在 Electron 启动阶段超过 40 秒，尚未执行到 MCP 操作。确认归属后停止该轮残留测试进程，未停止用户安装程序；本轮桌面验证不通过，不能据此声称安装版已验证。

相关核心专项覆盖 `agents`、`agent-mcp`、`draft-workflow`、`hierarchy`、`library-directories`、`note-hierarchy`、`presentation`、`rich`、`storage` 共 92 项。第一次使用 `--test-timeout=60000`：86 项通过，0 项业务断言失败，6 项因超时取消；用例同步磁盘操作可能导致实际退出晚于时限。

取消临时的 60 秒上限后，按名称单独重跑这 6 项，全部通过：方案出处与敏感性保留、退役 AI 隔离、草稿同步回执，以及旧迁移副本的确认、未知修改保护、未保存编辑保护。另通过撤销事务失败回滚和空工作区授权单项。不能把这些专项结果写为全量 `npm test` 通过。

专项命令：

```text
node --test --test-timeout=60000 tests/agents.test.mjs tests/agent-mcp.test.mjs tests/draft-workflow.test.mjs tests/hierarchy.test.mjs tests/library-directories.test.mjs tests/note-hierarchy.test.mjs tests/presentation.test.mjs tests/rich.test.mjs tests/storage.test.mjs
node --test --test-name-pattern="merge proposals retain|retired data cannot|v3 sync retains receipts" tests/agents.test.mjs tests/draft-workflow.test.mjs
node --test --test-name-pattern="old migration copy requires|old copy with unsynchronized|old migration copy with unsaved" tests/storage.test.mjs
```

最终语法检查及 `git diff --check` 通过。项目结构检查包含本报告；未为通过测试修改超时之外的产品执行边界。

## 原预览核对

13895 沿用已核实的 `.local/preview-0.1.1` 工作区，更新前无未保存标签或资料任务。重启前后保留 1 个知识库、1 篇笔记及 7 条事件，事件与 heads 的联合 SHA-256 均为 `f39d71c0a789654a6c6c1b0641e63460ba4499857aea421adfe20ae8fd966f0e`。旧的 1 条已撤销授权被清理，未创建真实新凭证。

重启后本机 MCP 继续使用原地址，旧 RPC 实测返回 404。浏览器已刷新并核对新版 MCP 页面，原知识库和工作标签仍在。未操作安装版数据、外部 Agent 配置或真实同步发布。

本轮未提交、推送、生成安装包或更新已安装应用。
