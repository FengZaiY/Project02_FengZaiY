# Agent 请求误过期修复验证

日期：2026-10-29。范围为操作请求快照与已拒绝项列表展示，不确认真实请求、不修改正式笔记、不打包。

## 原因与实现

AgentOperations.snapshot 将 SkillInstallations.list 全量加入请求快照；每分钟的后台检查即使没有文件或配置变化，也会更新 checkedAt，导致旧快照不匹配。重新发起后再次遇到后台检查，便重复出现“资料或配置已变化”。此前测试未覆盖已关联安装的周期检查。

新增测试真实导出并关联隔离 Skill，经 MCP 提交整理方案与确认请求，只运行检查即在修复前复现 stale 为 true。修复仅从快照排除 checkedAt，保留安装状态、版本、模式及原有知识版本头、偏好、同步/存储/授权校验；不降低本机确认、过期时间、未保存内容、撤销或业务基础版本保护。

已拒绝项在界面排序/100 条截断前过滤，刷新后仍隐藏。后台保留拒绝状态和回执，凭证专属结果查询仍返回 rejected，同 requestId 不重新执行。旧请求只有哈希，无法证明差异仅为时间，因此不更新其快照；必要时读取最新状态后重新发起一次。

## 本轮验证

- node --test tests/agent-operations.test.mjs tests/agent-mcp.test.mjs tests/skill-installations.test.mjs：32 项通过，见 artifacts/agent-request-fix-core.log。新测试覆盖周期检查、拒绝与重发、确认实际入库、结果查询、同 ID 幂等及真实模式变更拦截。
- node --test --test-concurrency=2 tests/*.test.mjs：391 项，首轮 390 通过；命名兼容测试读取旧 Git 提交时被目录归属检查阻止，见 artifacts/agent-request-fix-full.log。仅给复跑进程设置 GIT_CONFIG_COUNT/KEY_0/VALUE_0，限定信任当前源码目录，未改全局 Git 配置；naming-format 原样复跑 2 项通过，见 artifacts/agent-request-fix-naming-retry.log。
- 构建通过。操作请求浏览器专项通过，覆盖真实关联 Skill 检查后仍可确认、拒绝后隐藏且保留回执、真实资料修改使旧请求失效、授权表单输入保留及密码本机流程；见 artifacts/agent-request-fix-ui.log。
- Agent、通用界面、Skill 管理、启动回归通过：artifacts/agent-request-fix-agents-final.log、agent-request-fix-general-final.log、agent-request-fix-skill-ui.log、agent-request-fix-startup.log。
- 通用源码桌面及桌面 MCP 操作专项通过：artifacts/agent-request-fix-desktop.log、agent-request-fix-desktop-operations-final.log。实际安装程序未替换，未生成安装包。
- 1220/931/600 请求弹窗布局检查通过，已查看 artifacts/ui-agent-operations/requests-600.png，列表无已拒绝项。
- 项目结构及差异空白检查通过。

## 首次失败与边界

- 新复现测试在修复前失败于“检查时间变化不能使请求过期”，与本次缺陷一致。
- 原 Agent 界面脚本把全部 details summary 当作单个元素，与已有“高级维护”冲突；改为精确定位“需求基线”。通用脚本仍等待已退役的固定设置文案，改用现有存储扫描入口，并实际断言旧记录不存在且清理 pending 为 false。未为测试修改产品行为。原日志保留 agent-request-fix-agents.log、agent-request-fix-general.log。
- 首次桌面 MCP 专项在 Electron 启动阶段 40 秒超时，未进入业务断言；单独复跑通过。保留 agent-request-fix-desktop-operations.log，不推断所有环境启动超时已修复。

## 预览核对

13895 对应 .local/preview-0.1.1，“测试”知识库仍在。准备重启时旧 PID 已被并行任务替换，进程身份检查中止了本轮停止操作；随后核实当前预览进程启动于后端修复之后，无需再次重启。前后只读比对 events、heads、assets 及选定本机配置摘要一致，HTTP app.js 与 dist 构建摘要一致；检查脚本和摘要存于 artifacts/agent-request-preview-*。

当前运行的安装版来自独立安装目录，刷新或重启它不能取得本次源码修复，须后续更新安装版。未写正式资料、提交、推送、生成安装包或直接改写已安装 Skill。保留共享工作区中其他任务改动。
