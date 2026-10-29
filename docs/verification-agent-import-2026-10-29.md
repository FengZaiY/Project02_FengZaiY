# Agent 文件导入确认验证

日期：2026-10-29。Windows、Node 24.16.0、源码版本 0.1.17；本修复在固定发布提交 6d84cef15b5818439f9c8843413c465b3e5c5dd5 之后，未提交或纳入其安装包。保留已有发布文档修改。

## 问题与范围

用户两张截图中，PDF 导入请求因“资料或配置已变化”无法确认。隔离复现全库快照导致第一份文件导入、无关笔记保存使第二份请求失效；不能仅凭截图认定原 PDF 损坏，也未读取实际队列确认原失效事件。

仅 assetImport 使用窄范围快照。工作区/存储计划、目标库、发起授权和偏好继续校验；本机文件身份、大小、纳秒修改及变更时间进入确认令牌。新增受信任界面重新核对，保留原参数/幂等标识/到期时间，更新预览及令牌，仍须单独批准。旧全库快照请求只能显式转换，MCP 不可调用此入口。其他管理操作原保护不变，文件缺失、目标无效、撤销、到期、永久删除及未保存内容继续受保护。

## 验证结果

- `node --test tests/agent-operations.test.mjs`：12/12。覆盖独立导入顺序确认、无关笔记/Skill/同步状态变化、旧快照重新核对、旧令牌拒绝、MCP 越权、文件修改/缺失、目标改名、未保存、偏好变化、到期及原幂等/撤销流程。
- `npm test`：398/398，无失败、跳过或取消，约 236 秒。只给测试进程及子进程配置 Git safe.directory，未改全局配置。日志 `artifacts/agent-import-core-tests.log`。
- `npm run build`、`npm run test:agent-operations`：通过。验证两份真实 MCP 请求顺序导入、旧请求 UI 重新核对、不自动入库、再次确认以及重复资料复用；保留原权限/密码/拒绝流程。
- `npm run test:agent-operations-desktop`：通过。真实 Electron 与 MCP 经本机 IPC 重新核对改名后的目标，确认前仍为零附件，再次确认才导入；既有更新状态与本机流程断言通过，未执行安装器。
- `npm run test:agents`、`npm run test:skills`、`npm run test:ui`、`npm run test:startup`、`npm run test:desktop`：通过。桌面回归含隔离目录选择、取消、重启迁移及凭据保留。
- Skill `quick_validate.py skills/fengzaiy`：通过。仅更新 API 说明，未改变用户偏好基线，避免无关偏好版本变化。
- `npm run check:project` 与 `git diff --check`：通过，项目文件、文档链接、脚本及锁文件一致。
- 已查看 `artifacts/ui-agent-operations/import-reviewed-600.png`、`artifacts/desktop-agent-operations/native-import-rechecked.png`：文件与目标可读，确认可达，无遮挡。宽窄重新核对截图同目录保留。

## 失败及处理记录

专项测试首轮两项测试前提修正：未知 MCP 方法实际先由 schema 返回 INVALID，断言兼容 INVALID/FORBIDDEN；偏好变化改为调用实际 savePreferences，避免随机实体 ID 未改变有效偏好。后续 12/12 和完整核心均通过。

通用 Agent 界面首轮在原方案标签定位超时：普通点击来源已按既有产品规则替换标签。测试明确 Ctrl+单击新开来源标签，保留来源阅读、部分确认、权限与撤销断言后通过；未为测试修改导航实现。

预览重启后首次探测早于监听就绪，返回 ECONNREFUSED；随后真实页面启动及相同摘要核验均通过，不计首探成功。

## 预览与交付

重启前核实监听 13895 的 PID 765924、Node 路径及项目 server.mjs；原锚点和实际根目录均为 `.local/preview-0.1.1`，无未保存标签/目录维护忙碌。仅重启此预览，新的 PID 771916，版本 0.1.17、UI 协议 4，原“测试”知识库保留，服务 app.js 与 dist 摘要一致。

重启前后只读 SQLite 核验 events、heads、assets 及同步/授权/秘密配置摘要一致。记录为 `artifacts/agent-import-preview-before.json` 与 `agent-import-preview-after.json`；页面无启动或脚本错误，截图 `agent-import-preview-ready.png`。未读取、导入或批准用户截图中的正式 PDF，未覆盖正式安装版或外部 Agent 配置。真实安装升级与用户原请求恢复未验证；到期请求仍需 Agent 新发起，不能通过本修复延长或复活。

没有提交、推送、打包或发布。本次源码和预览可用，安装版须由后续发布任务纳入修复后升级。
