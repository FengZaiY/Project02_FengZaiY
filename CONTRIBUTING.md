# 开发与维护

## 环境和首次运行

在 Windows 项目根目录工作，使用 Node.js 24 与 npm。依赖以 `package-lock.json` 锁定；安装桌面版的用户不需要 Node.js。

当前应用不依赖 Git，也不提供本地独立备份。源码协作与退役 v2 兼容测试仍使用 Git for Windows，不能把测试依赖当作用户运行要求。

```powershell
npm ci
npm run check:project
npm run build
npm test
```

`npm ci` 会按锁文件重建依赖目录，并可能下载 Electron。需要网络或权限时先获得批准；不要绕过限制或为运行本项目修改全局配置。

桌面开发使用 `npm start`。浏览器开发使用 `npm run dev`，默认仅监听 `127.0.0.1:4317`。预览前先构建；修改后端源码后，须按原启动参数重新启动服务，再刷新页面。仅重新构建前端不会重载已运行的 Node 模块；当前没有自动热更新。交付预览时核验服务实际版本、工作区位置与页面，不能只检查页面标题或端口可达。

`npm run test:startup` 验证旧后端、网络和初始化失败的错误页、重新加载、未保存草稿保护及窄窗布局。可信界面接口发生不兼容变化时更新 `src/core/ui-protocol.mjs` 的协议编号，前后端必须一起更新；该编号与同步格式及产品版本分开。

如果端口被占用，在当前 PowerShell 会话选择另一个端口，不终止不明进程：

```powershell
$env:PORT = '4318'
npm run dev
```

浏览器预览默认数据目录为 `.local/preview`。`FENGZAIY_DATA` 可设置独立测试数据目录；不要指向运行中的正式桌面数据库。

Windows 预览的目录按钮通过已鉴权的界面接口调用系统文件夹窗口，使用系统自带 Windows PowerShell 的固定 STA 脚本，不修改执行策略或接受用户命令。需要交互式 Windows 桌面；非 Windows 环境显示不支持提示。根目录入口先选文件夹，再检查与确认。`tests/directory-picker.test.mjs` 覆盖取消、失败、并发、鉴权及关闭清理；`test:storage` 用隔离选择器验证界面，不弹出真实窗口。原生窗口外观与真实手动选择应单独核对。

本地存储设置以初始启动目录为配置锚点，在相邻的 `<初始目录>.storage.json` 保存当前路径和待生效变更，不写进共享知识版本。桌面 `--data-dir=<目录>` 与预览 `FENGZAIY_DATA` 均选择锚点；设置迁移后继续用相同参数启动，自动打开新路径。默认桌面锚点为 Electron userData 下的 `workspace`。不要把锚点配置当作同步文件，也不要手工复制运行中的 SQLite。

目录切换仅在重启时执行。已有启动配置对应的数据库不存在、损坏或凭据环境不匹配时明确失败，不初始化空库。迁移失败目标留有 `.fengzaiy-incomplete.json` 标记，不可打开；源目录保留，重新选择另一个空目录重试。不要在未核对位置和内容前删除任何失败目录。老版本不识别新占用锁，迁移前必须关闭旧版本。

## 验证矩阵

命名兼容专项：`node --test tests/branding.test.mjs tests/naming-format.test.mjs`，构建后运行 `node scripts/test-naming-ui.mjs` 和 `node scripts/test-naming-startup.mjs`。覆盖旧链接与身份、新 MCP 配置/Skill 导出、旧安装迁移提示和新启动变量优先级；格式专项只做单工作区清单预检，不替代多电脑同步验收。证据见 [命名验证](docs/verification-fengzaiy-naming-2026-10-27.md)。

用户明确排除多电脑同步时，使用 `node scripts/test-local-audit.mjs core` 选择本机用例，不直接运行含同步的 `npm test` 或 `test:ui`；检查生成的 `artifacts/local-audit/core-selection.json`，新增参数化测试须补充选择。这个选择器只服务限定范围审查，不能替代同步改动所需的完整验证。其他本机界面和源码桌面脚本按下表选择，测试须使用隔离目录。

`node scripts/test-local-audit-ui.mjs` 验证业务保存竞态、切页旧事件及窄窗；`node scripts/test-business-workflows.mjs` 串联任务关联、财务、订阅付款撤回重做、中文 CSV 退款、回收恢复和密码恢复。可用 `node scripts/test-local-audit.mjs <日志批次名> <脚本名不含扩展名> ...` 顺序运行并保存结果。核心补充回归在 `tests/local-audit.test.mjs`；实际 MCP 与随附客户端覆盖在 `tests/agent-mcp.test.mjs`。本机审查结果与边界见 [验证记录](docs/verification-local-audit-2026-10-27.md)。

个人管理升级使用 `node --test tests/personal-system.test.mjs tests/agent-mcp.test.mjs tests/storage.test.mjs` 覆盖金额精度、事务批次、撤回、秘密隔离、独立密码库合并、资料迁移及新根目录恢复。构建后 `npm run test:personal` 验证五板块、跨页草稿、键盘保存、财务、密码库、修改记录和窄窗口；`npm run test:personal-desktop` 用独立 Electron profile 验证原生剪贴板、模拟锁屏及退出保存。测试输出在 artifacts。原生进程启动失败须记录失败阶段，只清理该次测试 PID，不以核心通过替代桌面结论。还需运行完整核心和既有界面回归。

系统检查修复专项：`npm run test:audit-fixes` 使用隔离 Electron 工作区验证凭证/Skill/路径复制与手动回退、偏好保护、进行中及确认后新增导入、取消、退出响应和关闭数据库后重启。另运行 `node --test tests/asset-reader.test.mjs tests/current-sync.test.mjs tests/exit-check.test.mjs`，覆盖原件完整性、媒体缓存失效、缺块补齐与重启握手。测试拦截重启以避免启动第二个实例，不操作正式资料或生成安装包。

设备管理变更运行 `node --test tests/device-management.test.mjs tests/current-sync.test.mjs`、`npm test`、`npm run test:devices`、`npm run test:ui` 及 `npm run test:desktop`。用隔离双目录验证主力权限、幂等、改名冲突、停用/恢复、目标原件完整性、转移与取消并发、旧冻结发布和 format 5/删除凭据兼容，不对真实设备试做停用或转移。

MCP 适配使用生产依赖 `@modelcontextprotocol/sdk` 和 `zod`，是唯一外部连接；旧 HTTP RPC 已停用。修改后运行 `node --test tests/agent-mcp.test.mjs tests/agents.test.mjs`、`npm run test:agents`、`npm run test:skills` 和 `npm run test:desktop`。有效凭证开放全部知识库及现有 Agent 读写能力；测试撤销删除、迁移、未来知识库、敏感引用以及系统操作仍不可访问。禁止将受信任界面 RPC 暴露为通用 MCP 调用器。客户端连接配置见 [接入说明](docs/agent-mcp.md)。

| 改动类型 | 至少执行 |
|---|---|
| 文档和目录约定 | `npm run check:project` |
| `src/core/` | `npm test` |
| 清空回收站、永久删除凭据 | 另运行 `node --test tests/permanent-deletion.test.mjs tests/trash.test.mjs tests/current-sync.test.mjs tests/storage.test.mjs`、`npm run test:trash`、`npm run test:libraries`、`npm run test:assets`、`npm run test:agents`、`npm run test:storage`；覆盖正文历史实际删除、原件/共用保护、可重试文件任务、数据库压缩失败、替换索引失败、旧副本确认、重复/乱序同步及未知并发版本阻断；不得用正式回收内容测试 |
| 当前内容同步、批次与接收断点 | `node --test tests/current-sync.test.mjs tests/sync-publication.test.mjs`、全量核心、`npm run test:sync-publication` 及界面/桌面测试；覆盖缺块、重启、损坏前缀、空间不足、重复、并发及清单替换占用。Windows 专项用临时文件真实句柄验证锁释放后成功，不访问真实同步目录 |
| 多电脑同步界面与操作流程 | `node --test tests/sync-ui-state.test.mjs`、`npm run test:sync-ui`，另运行通用界面、设备、修改记录检查与源码桌面回归；使用隔离双目录检查初次配对、配置输入保留、冻结与批次、上传确认取消、缺块、仅索引后完整接收、并发冲突入口、防重复点击及切页后编辑保留；检查 1464、1220、931、600 宽度和底部可达 |
| 解除本机同步绑定 | `node --test tests/sync-disconnect.test.mjs`、`npm run test:sync-ui`、全量核心、通用界面、设备及源码桌面；验证显式确认、过期/重复/忙碌请求、事务失败回滚、未完成任务取消、知识与原件/共享文件/断点保留、重启重新配对及设备策略不绕过；不得对真实工作区执行解绑测试 |
| 退役 AI 数据迁移 | `node --test tests/retired-ai.test.mjs`、全量核心、`test:ui`、`test:agents`、`test:skills`、`test:storage`；检查旧密钥和正文删除、正常笔记与草稿保护、旧同步重复/新分支拦截、工作区替换身份一致及失败回滚 |
| 退役 Git/独立备份兼容模块 | 现有 `git-sync.test.mjs` 等仅维护旧格式读取证据，不恢复当前产品入口 |
| `web/` 或跨端业务调用 | `npm run build`、`npm run test:ui`，必要时核心测试 |
| 交互阅读退役清理 | `npm test`、`npm run build`、`test:retired-reading`、`test:ui`、`test:rich`、`test:experience`、`test:agents`、`test:skills`、`test:drafts`、`test:trash`、`test:desktop`；检查旧数据事务迁移、损坏拒绝、正文/原件/草稿确认结果保留、重复与乱序同步、加密对象替换失败重试、历史恢复以及宽窄窗口无旧入口 |
| 草稿直接归档、方案来源关联与处理状态 | `npm run test:drafts`、`node --test tests/draft-workflow.test.mjs`；另运行完整核心、知识库/层级/Agent 界面回归，核对来源版本、部分覆盖、未保存修改、取消、重复、失败回滚、双目录同步及授权 |
| 草稿与正式笔记共用界面 | `npm run test:drafts`、`npm run test:experience`、`npm run test:attachments`；另以 `node scripts/test-editor-experience.mjs --draft` 和 `node scripts/test-note-attachments.mjs --draft` 验证草稿工具/附件，核对导航切换不重建编辑器、紧凑保存、重开草稿范围及窄窗口 |
| 系统设置的内置 Skill 管理 | `npm run test:skills`、`npm run test:agents`、`npm test`；核对只读文件、导出版本清单、偏好快照、历史取回、保存期间输入、未保存内容保护与过期版本对照。导出生成记录不表示外部安装成功 |
| 在线升级更新 | `node --test tests/updates.test.mjs`、`npm run test:updates`、`test:ui`、`test:desktop`；验证固定来源、错误/并发、真实更新库的隔离下载与损坏校验、未保存保护、普通退出不安装、开发环境限制与 Agent 越权 |
| 笔记富内容、链接、媒体或画板 | 另运行 `npm run test:rich`，检查所有模板、保存重开、原文件播放、画板像素和桌面/窄窗口截图；原生协议/本地文件绑定另测 `test:desktop` |
| 思维导图可视化编辑 | 另运行 `npm run test:mindmap`、`node --test tests/mindmap.test.mjs`；覆盖源文本保留、实体编码、中文输入、分支移动/循环/折叠、保存重开、取消、撤销、导出及窗口截图 |
| 正文富媒体尺寸调整 | 另运行 `npm run test:rich-layout`；覆盖导图八方向实际缩放、图表/画板比例、调节点边界、取消/撤销、键盘、长按编排、双击编辑、保存重开、历史与窄窗口，不以布局属性变化代替可见尺寸验证 |
| 富内容行间拖动 | 另运行 `npm run test:line-drag`、`node --test tests/block-layout.test.mjs`；检查换行/自动折行落点、上下移动、列表/引用/表格、行内格式与链接、横排移出、再次拖动、取消、一次撤销与保存重开 |
| 富内容横向排列 | 另运行 `npm run test:horizontal-drag`；真实鼠标拖到素材左右空白，检查竖向提示、小导图与竖图、附件面板展开、引用内横排、窄区域保持并排、比例、缩放、换序、移出、取消、撤销和保存重开 |
| DOCX 附件预览 | `npm run test:docx-preview`、`test:attachments`、`test:attachment-drag`、`test:assets`、`test:ui` 与 `test:desktop`；检查正文/表格/图片/列表、旧 MIME、损坏/解压限制、隔离与无外部请求、取消/竞态、放大和长列表可见性、编辑器/撤销保留与窗口截图 |
| 文件拖入、内容布局、自动保存 | 另运行 `npm run test:editor`、`npm run test:document` 和 `node --test tests/note-autosave.test.mjs`；验证媒体长按/缩放、旧正文框展开、回车退格/选择/撤销、粘贴与长文自适应、切换笔记、保存中输入、失败重试、冲突暂停。桌面真实 File 路径桥接由 `test:desktop` 覆盖 |
| 浮动工具、快捷插入、正文目录、引用和历史差异 | `npm run test:experience`、`node --test tests/editor-experience.test.mjs`；包含输入法、格式状态、阅读设置、表格/图片粘贴、代码复制、跨库引用、备注歧义、查找、局部恢复及多窗口截图。桌面无路径剪贴板图片另测 `test:desktop` |
| 知识库管理和范围选择 | 另运行 `npm run test:libraries`，检查用户视口与空工作区 |
| 资料目录、属性与回收 | 另运行 `npm run test:assets`、`node --test tests/asset-management.test.mjs`；覆盖文件身份、引用保护、批量回滚、过期编辑、历史/同步、分页与多视口截图 |
| 附件导入去重与合并 | 另运行 `npm run test:dedup`、`node --test tests/asset-merge.test.mjs`；覆盖并发复用、明确独立导入、缺失/损坏原件、取消/过期预览/未保存、引用重写、失败回滚、历史/恢复及并发同步；只使用隔离重复资料 |
| 原附件面板及关联管理 | 另运行 `npm run test:attachments`、`npm run test:libraries`；覆盖本地导入、库内关联、解除/取消、正文及其他笔记引用保留、未保存正文与撤销、保存中输入、失败重试、冲突暂停和窄窗口；预览开关另运行 `test:docx-preview`、`test:attachment-drag`，检查关闭/重开、延迟结果取消、视频停止、紧凑行和完整名称提示 |
| 原附件拖入正文 | 另运行 `npm run test:attachment-drag`；使用真实鼠标验证图片/视频/链接落点、空白笔记、边缘滚动、预览、取消、撤销、重复不重新导入、校验期间输入、失效/伪造数据、切换笔记、保存重开及窄窗口 |
| 资料缩略图、筛选布局 | 另运行 `npm run test:asset-previews`；检查真实图片/视频帧、静音不自动播放、不可用/失败占位、按可见区域加载、离开页面清理、长标签完整显示和多窗口截图；桌面媒体协议由 `test:desktop` 验证 |
| 资料本机目录展示 | 另运行 `npm run test:asset-storage`；检查真实目录与文件绑定、笔记层级/共享/回收、待下载/缺失/外部绑定、路径复制、目录及跨库筛选、分页总数、多窗口截图和只读不改知识记录；本机路径不得进入外部 Agent 返回 |
| 笔记知识体系与后台文件 | 另运行 `npm run test:hierarchy`、`node --test tests/note-hierarchy.test.mjs tests/hierarchy.test.mjs`；覆盖上下级、提案依赖/部分确认/授权、旧分类幂等转换、新机同步、并发循环、磁盘失败、文件保护和截图 |
| 笔记树拖动 | 另运行 `npm run test:note-drag`、`node --test tests/note-order.test.mjs`；真实鼠标验证下级/顶层/同级前后、整条子树、排序重开/同步/并发、循环/跨库阻止、取消/长树滚动、当前及后台标签保存竞态、失败重试、源及目标过期、编辑器/预览/撤销保留，以及层级目录跟随和单纯排序不搬原件 |
| 根目录与知识库文件夹 | `npm test` 含 `library-directories.test.mjs`；另测 `test:storage`、`test:libraries` 和 `test:desktop`，核对真实目录、旧库兼容、创建失败回退及跨库新附件位置 |
| 本地存储与启动目录 | 另运行 `npm run test:storage`、`npm run test:desktop`；覆盖非空/占用/丢失/损坏目录、复制失败、配置写入失败、WAL 和重启持久化 |
| 同步接收目录 | `node --test tests/received-objects.test.mjs`、`node scripts/test-received-objects-ui.mjs`；覆盖空目录、绑定/链接保护、未知文件、异常路径、失败重试、重启续传、分页及未保存偏好保留。相关同步和目录维护回归继续执行 |
| 修改记录校验 | `node --test tests/revision-integrity.test.mjs`、`node scripts/test-revision-integrity-ui.mjs`；验证新写入落盘/重启一致、旧原哈希证明、双向同步与并发、实际篡改拒绝、诊断只读及外部 Agent 禁止访问。全量核心与同步界面必须回归，不改历史哈希以让测试通过 |
| 外部 Agent、权限、偏好和 Skill | 另运行 `npm run test:agents`，核心测试通过真实本机 HTTP 验证隔离、撤销、幂等和偏好更新；检查导出的 ZIP |
| 主进程、预加载、凭据和 IPC | 核心测试、构建、`npm run test:desktop` |
| 桌面退出与保存检查 | 另运行 `npm run test:exit`、`node --test tests/exit-check.test.mjs tests/note-autosave.test.mjs`；验证受信任握手、重复关闭/取消/超时、后台操作保护、多标签保存、冲突不分支、未保存偏好与弹窗、结构化错误码及退出后数据库落盘；使用 `--smoke-test --test-exit` 隔离源码实例 |
| 日常依赖或桌面代码修改 | 相关核心/界面测试、按需 `npm run test:desktop`，不生成安装包 |
| 用户明确指定的安装包任务 | 相关测试、`npm run dist`、`npm run test:packaged` |
| 查询、索引或大批数据路径 | 相关测试、`npm run benchmark` |
| 可选双机部署联调 | 按需参照 [同步验收](docs/baidu-acceptance.md) 记录实际环境，不作为开发或原件释放前置条件 |

`check:project` 检查必需文件、文档本地链接目标、命令入口及依赖锁文件一致性；它不是代码 lint、安全审计或 Codex 实际加载测试。

界面测试需要 Playwright 可用浏览器，现有脚本可尝试本机 Edge。原生桌面测试启动隔离的 Electron 实例，可能需要桌面/沙箱权限。不要让测试与正式资料共用数据目录。

测试报告和截图写入 `artifacts/`。没有通过的检查不得标为通过，未执行的检查应说明原因。既有验证记录仅代表其标注日期的版本。

## 构建与交付

日常开发只更新源码、本地预览和相关测试，不生成或更新安装包。用户会另开任务按需安排打包；不要自动执行打包命令、创建打包任务或把缺少新安装包视为开发未完成。`npm run build` 仅生成预览与测试需要的界面文件，可以正常执行。

以下安装包命令仅适用于用户明确指定的打包任务。

`npm run dist` 生成 `release/FengZaiY-<版本>-Setup.exe`。`npm run test:packaged` 验证 `release/win-unpacked/FengZaiY.exe`，不等于验证安装向导、卸载或跨版本升级。

在线更新源码已接入 electron-updater，默认共用 `FengZaiY/Project02_StudySelf` 的公开 GitHub Releases（package metadata 保存来源）。独立打包任务可通过 `FENGZAIY_UPDATE_GITHUB=owner/repo` 或 `FENGZAIY_UPDATE_URL=https://.../` 二选一覆盖来源，`scripts/release-config.mjs` 同时生成发布配置和安装包内来源。`npm run dist` 使用 `--publish never`，只构建、不上传。详细流程见 [在线发布说明](docs/online-updates.md)。版本号涉及 `package.json`、锁文件、业务状态和界面显示；发布时搜索所有版本引用，避免只改其中一个。交付说明保留实际签名状态及本轮测试范围，不把百度产品能力验证列为交付门槛。

日常修改后保留旧安装包，不把它宣称为包含最新源码。进入独立打包任务时，再基于指定源码构建并验证新安装包，不能沿用旧产物冒充本次交付。

## Git 和数据

- 项目在本地 `main` 分支初始化；是否建立首个提交或远程仓库由用户决定。
- 本项目仓库只管理源码、配置、文档与测试。应用不再生成用户 Git 仓库；既有退役仓库不删除、不提交源码仓库、不直接放入同步空间。
- `.local/`、`artifacts/`、`dist/`、`release/`、数据库和密钥被忽略；不要使用强制添加绕过保护。
- 保留 `package-lock.json`。只有实际修改依赖时才更新锁文件。
- 当前没有仓库级 CI 或 lint/format 工具，不宣称不存在的检查已执行。

## 文档维护

先阅读 [AGENTS.md](AGENTS.md)。新需求、能力状态、工程约定和设计决策分开维护，避免一个文档变成聊天记录。

复杂任务使用 [计划约定](docs/plans/README.md)，重要架构变化使用 [决策约定](docs/decisions/README.md)。完成后更新相关状态和验证依据，不自动把“计划”改写成“已实现”。

Skill 源码位于 `skills/fengzaiy/`，随应用发布；从“系统设置”页导出含当前偏好快照的 ZIP，解压后将 `fengzaiy` 目录交给目标 Agent 的 Skill 管理入口。“系统设置”维护整理偏好，“外部 Agent”管理 MCP、凭证和访问记录。宿主使用 MCP 配置；明确采用 Node 脚本时使用 `FENGZAIY_AGENT_URL`（MCP 地址）与 `FENGZAIY_AGENT_TOKEN` 环境变量。不得把真实凭证写进 Skill、仓库、示例或测试报告。

接口和偏好变化必须同步更新 Skill。`bootstrap` 在运行时提供最新版指引；用户在“安装更新”关联的本机位置可检查后确认或自动更新，未关联位置不改写。运行 `node --test tests/skill-installations.test.mjs` 与 `npm run test:skills` 验证文件保护、失败/重启恢复、锁、过期预览、模式、目录弹窗及布局；测试只关联隔离目录，禁止使用真实外部 Agent 安装。内置模型/讨论专项脚本已退役，不能把历史测试结果当作当前功能。
