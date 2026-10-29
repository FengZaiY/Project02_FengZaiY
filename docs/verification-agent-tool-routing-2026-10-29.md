# FengZaiY 工具误调用防护验证

## 变更

- 技能及 API 明确 FengZaiY 查询、文件导入、操作状态、笔记附件合并及回读接口；Codex list_artifacts 不能作为资料库查询或完成依据。
- 首次无关结果即停止同类重复，重新发现工具；缺失能力须明确报告。此处为 Agent 行为规则，不是跨应用工具调用拦截器。
- MCP 初始化说明和 search、noteUpdate、operation、operationResult 工具描述补充业务路径；不改工具数、参数及权限。
- 新增 tests/agent-tool-routing.test.mjs：独立服务及多个新 SDK 客户端验证导入待确认/完成、跨范围查询、请求重放、完整笔记关联、基础版本冲突及偏好传播。

## 已验证

- node --test tests/agent-tool-routing.test.mjs tests/agent-mcp.test.mjs tests/agent-operations.test.mjs tests/skill-installations.test.mjs：38/38 通过。
- npm run test:agents：通过，包含授权、业务方案、偏好、技能导出与撤销。
- npm run test:skills：通过，包含偏好、导出、安装更新/恢复、手工改动保护、缺失文件修复及重启。
- git diff --check：通过。
- npm run check:project：通过，105 个必需文件、211 份文档、311 个本地链接及脚本/锁文件契约。

## 生效范围与待办

源码内默认技能和工具说明已修改；当前安装版仍为 0.1.17，未打包、替换或发布。通过已支持的整理偏好让当前 bootstrap 取得规则；Codex 技能副本安装更新已完成。安装版 SKILL.md 主文与 MCP 发现描述仍来自原安装包，新增规则通过运行中偏好及本地 references/preferences.md 提供；不能声称安装程序已包含源码描述更新。

保存整理偏好请求 f14e69e4-a8f2-429e-a85e-0971bd481177 经用户本机确认，2026-10-29 19:19（北京时间）回读为 completed；bootstrap 返回文本与拟保存规则完全一致，无偏好冲突。偏好版本为 5a41131879defa489b4f61b7bc02fbcdabe2464478019e9cb3d607ed5514222d，保持原基线。Codex 已关联安装 id 为 e8cbcd20-c2cc-4c0c-b427-9bb184fdff35；预览更新请求 7ca01f20-dbd1-4c27-a9fe-249390676369 completed，差异仅 references/preferences.md 与 manifest.json，未检测到手工修改或缺失文件。安装请求 da8297dd-efbd-4c5b-b3d1-63084a8d3c5b 经用户本机确认，于 19:22:03 完成；安装列表 status:current，无错误/缺失/手工修改。导出版本 7ccb66a7087bdc99aeb18a8db4b9966805b4b86e6348bafb58a0b0bb32182a57；文件回读确认完整规则及偏好版本一致，manifest 各版本与 bootstrap/安装结果一致。不手工覆盖受管理文件，其他 Agent 安装不主动改动。

新 SDK 连接验证协议行为，不等同于外部模型在新对话中的自主工具选择。独立对话 01a18763-a8c4-76f1-80f1-ddc50fa144d9（FengZaiY 新对话只读验证）已完成：给出按技能查询既有套餐原件及关联笔记的任务，不提示具体工具路径，禁止正式写入。其读取本机技能后实际调用 bootstrap、libraries、search(asset)、record、search(note)、operation_catalog、operation(assetDetail)；七次均完成，未调用 list_artifacts、未提交写入或确认请求。使用上述新偏好版本。另有一次无业务意义的 Shell 提示输出，未替代业务调用；不能将本例描述为最少调用或全流程效率验证。

其结果核实原件 id 9acaa667-9ac5-4304-b14e-642f149111b5 可用、未删除、无冲突，assetDetail referencesUnknown:false，关联三篇装修笔记（套餐配置、报价核对、报价总览）及一条来源。任务于本地技能副本更新前启动，通过 bootstrap 获取新偏好后完成，可作为运行中共享规则已被新对话使用的证据；本地快照另以文件和安装结果回读验证。此例验证查询和关联读取；自主模型正式导入/写入未重做，以隔离 SDK 测试覆盖，避免增加正式测试数据。

单次模型验证不保证后续绝不误选，无法拦截宿主其他工具。不更改正式附件、笔记、授权或 Codex 宿主机制。测试批准仅在隔离服务内模拟，正式请求不能代用户确认。最终项目检查及差异检查通过；未提交、推送或发布。
