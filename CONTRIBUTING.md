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

桌面开发使用 `npm start`。浏览器开发使用 `npm run dev`，默认仅监听 `127.0.0.1:4317`。预览前先构建，源码修改后需重新构建并刷新；当前没有自动热更新。

如果端口被占用，在当前 PowerShell 会话选择另一个端口，不终止不明进程：

```powershell
$env:PORT = '4318'
npm run dev
```

浏览器预览默认数据目录为 `.local/preview`。`STUDYSELF_DATA` 可设置独立测试数据目录；不要指向运行中的正式桌面数据库。

Windows 预览的目录按钮通过已鉴权的界面接口调用系统文件夹窗口，使用系统自带 Windows PowerShell 的固定 STA 脚本，不修改执行策略或接受用户命令。需要交互式 Windows 桌面；非 Windows 环境显示不支持提示。根目录入口先选文件夹，再检查与确认。`tests/directory-picker.test.mjs` 覆盖取消、失败、并发、鉴权及关闭清理；`test:storage` 用隔离选择器验证界面，不弹出真实窗口。原生窗口外观与真实手动选择应单独核对。

本地存储设置以初始启动目录为配置锚点，在相邻的 `<初始目录>.storage.json` 保存当前路径和待生效变更，不写进共享知识版本。桌面 `--data-dir=<目录>` 与预览 `STUDYSELF_DATA` 均选择锚点；设置迁移后继续用相同参数启动，自动打开新路径。默认桌面锚点为 Electron userData 下的 `workspace`。不要把锚点配置当作同步文件，也不要手工复制运行中的 SQLite。

目录切换仅在重启时执行。已有启动配置对应的数据库不存在、损坏或凭据环境不匹配时明确失败，不初始化空库。迁移失败目标留有 `.studyself-incomplete.json` 标记，不可打开；源目录保留，重新选择另一个空目录重试。不要在未核对位置和内容前删除任何失败目录。老版本不识别新占用锁，迁移前必须关闭旧版本。

## 验证矩阵

| 改动类型 | 至少执行 |
|---|---|
| 文档和目录约定 | `npm run check:project` |
| `src/core/` | `npm test` |
| 当前内容同步、批次与接收断点 | `node --test tests/current-sync.test.mjs`、全量核心及界面/桌面测试；覆盖缺块、重启、损坏前缀、空间不足、重复与并发 |
| 退役 Git/独立备份兼容模块 | 现有 `git-sync.test.mjs` 等仅维护旧格式读取证据，不恢复当前产品入口 |
| `web/` 或跨端业务调用 | `npm run build`、`npm run test:ui`，必要时核心测试 |
| 笔记富内容、链接、媒体或画板 | 另运行 `npm run test:rich`，检查所有模板、保存重开、原文件播放、画板像素和桌面/窄窗口截图；原生协议/本地文件绑定另测 `test:desktop` |
| 文件拖入、内容布局、自动保存 | 另运行 `npm run test:editor` 和 `node --test tests/note-autosave.test.mjs`；验证长按一秒/短按取消、四边四角缩放、悬浮落点/布局重开、切换笔记、保存中输入、失败重试、冲突暂停。桌面真实 File 路径桥接由 `test:desktop` 覆盖 |
| 知识库管理和范围选择 | 另运行 `npm run test:libraries`，检查用户视口与空工作区 |
| 根目录与知识库文件夹 | `npm test` 含 `library-directories.test.mjs`；另测 `test:storage`、`test:libraries` 和 `test:desktop`，核对真实目录、旧库兼容、创建失败回退及跨库新附件位置 |
| 本地存储与启动目录 | 另运行 `npm run test:storage`、`npm run test:desktop`；覆盖非空/占用/丢失/损坏目录、复制失败、配置写入失败、WAL 和重启持久化 |
| 外部 Agent、权限、偏好和 Skill | 另运行 `npm run test:agents`，核心测试通过真实本机 HTTP 验证隔离、撤销、幂等和偏好更新；检查导出的 ZIP |
| 主进程、预加载、凭据和 IPC | 核心测试、构建、`npm run test:desktop` |
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

`npm run dist` 生成 `release/StudySelf-<版本>-Setup.exe`。`npm run test:packaged` 验证 `release/win-unpacked/StudySelf.exe`，不等于验证安装向导、卸载或跨版本升级。

目前没有自动更新服务器，升级使用新安装包。版本号涉及 `package.json`、锁文件、业务状态和界面显示；发布时搜索所有版本引用，避免只改其中一个。交付说明保留实际签名状态及本轮测试范围，不把百度产品能力验证列为交付门槛。

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

Skill 源码位于 `skills/studyself-organize/`，随应用发布；从“系统设置”页导出含当前偏好快照的 ZIP，解压后将 `studyself-organize` 目录交给目标 Agent 的 Skill 管理入口。“系统设置”维护整理偏好，“外部 Agent”管理连接、授权和访问记录。具备本机 HTTP/Node 能力的 Agent 使用 `STUDYSELF_AGENT_URL` 与 `STUDYSELF_AGENT_TOKEN` 环境变量接入。不得把真实凭证写进 Skill、仓库、示例或测试报告。

接口和偏好变化必须同步更新 Skill。`bootstrap` 在运行时提供最新版指引；安装副本不会被后台自动改写。内置模型/讨论专项脚本已退役，不能把历史测试结果当作当前功能。
