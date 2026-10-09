# 开发与维护

## 环境和首次运行

在 Windows 项目根目录工作，使用 Node.js 24 与 npm。依赖以 `package-lock.json` 锁定；安装桌面版的用户不需要 Node.js。

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

## 验证矩阵

| 改动类型 | 至少执行 |
|---|---|
| 文档和目录约定 | `npm run check:project` |
| `src/core/` | `npm test` |
| `web/` 或跨端业务调用 | `npm run build`、`npm run test:ui`，必要时核心测试 |
| 主进程、预加载、凭据和 IPC | 核心测试、构建、`npm run test:desktop` |
| 依赖、安装包或发布候选 | 相关测试、`npm run dist`、`npm run test:packaged` |
| 查询、索引或大批数据路径 | 相关测试、`npm run benchmark` |
| 实际百度网盘能力 | [人工双机验收](docs/baidu-acceptance.md)，不能由单元测试替代 |

`check:project` 检查必需文件、文档本地链接目标、命令入口及依赖锁文件一致性；它不是代码 lint、安全审计或 Codex 实际加载测试。

界面测试需要 Playwright 可用浏览器，现有脚本可尝试本机 Edge。原生桌面测试启动隔离的 Electron 实例，可能需要桌面/沙箱权限。不要让测试与正式资料共用数据目录。

测试报告和截图写入 `artifacts/`。没有通过的检查不得标为通过，未执行的检查应说明原因。既有验证记录仅代表其标注日期的版本。

## 构建与交付

`npm run dist` 生成 `release/StudySelf-<版本>-Setup.exe`。`npm run test:packaged` 验证 `release/win-unpacked/StudySelf.exe`，不等于验证安装向导、卸载或跨版本升级。

目前没有自动更新服务器，升级使用新安装包。版本号涉及 `package.json`、锁文件、业务状态和界面显示；发布时搜索所有版本引用，避免只改其中一个。未签名与真实双机未验收的限制必须保留在交付说明中。

本次项目整理不改变已有安装包；仅工程文档、开发命令和校验脚本变化无需重新发布应用。

## Git 和数据

- 项目在本地 `main` 分支初始化；是否建立首个提交或远程仓库由用户决定。
- Git 仅管理源码、配置、文档和可重复运行的测试，不是用户知识库同步通道。
- `.local/`、`artifacts/`、`dist/`、`release/`、数据库和密钥被忽略；不要使用强制添加绕过保护。
- 保留 `package-lock.json`。只有实际修改依赖时才更新锁文件。
- 当前没有仓库级 CI 或 lint/format 工具，不宣称不存在的检查已执行。

## 文档维护

先阅读 [AGENTS.md](AGENTS.md)。新需求、能力状态、工程约定和设计决策分开维护，避免一个文档变成聊天记录。

复杂任务使用 [计划约定](docs/plans/README.md)，重要架构变化使用 [决策约定](docs/decisions/README.md)。完成后更新相关状态和验证依据，不自动把“计划”改写成“已实现”。
