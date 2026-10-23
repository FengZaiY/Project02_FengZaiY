# MCP 剪贴板复制修复验证

日期：2026-10-23。环境：Windows、Node.js 24.16.0、源码版本 0.1.8；测试使用隔离工作区。仓库同时存在发布文档及 Skill 安装修复改动，本轮不撤回、不提交这些改动。

## 问题与修改

用户点击“复制 Streamable HTTP”收到 `Clipboard: Write permission denied`。`web/agent-mcp.js` 原先直接调用 `navigator.clipboard.writeText`，没有兼容路径。

- MCP 地址、Codex 配置和通用 HTTP 配置改用现有 `copyText`：现代接口失败后尝试浏览器兼容复制。
- 两种自动复制方式均失败时，选中可见地址或配置，提示“自动复制受限，已选中地址/配置，请按 Ctrl+C 复制”。只有成功才显示“已复制”。
- 共用复制工具在兼容接口抛错时也执行清理，移除临时输入框并恢复焦点和文档选区。
- 不修改权限、沙箱、MCP 传输、连接地址、凭证和外部 Agent 配置。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm run check:project` | 通过 |
| `npm run test:agents` | 通过；新增权限拒绝、接口不可用、兼容返回 false/抛错测试 |
| `npm run test:ui` | 通过 |
| `npm run test:experience` | 通过 |
| `node --test tests/editor-experience.test.mjs` | 4 项通过 |
| `node --test tests/agent-mcp.test.mjs` | 5 项通过 |
| `npm run test:desktop` | 受限环境首次启动超时；正常权限下隔离源码桌面完整通过，包括迁移重启 |

Agent 回归对地址和两类配置逐一检查内容、成功提示、兼容复制后焦点恢复、手工兜底选区、失败不改剪贴板及临时节点清理。Windows 原生复制可能使用 CRLF，测试仅规范换行后比较内容。源码桌面真实点击三个复制入口，再通过主进程读取系统剪贴板核对内容，未放宽渲染进程权限。界面回归无 pageerror。

截图检查：`artifacts/ui-agents/mcp-copy-manual.png` 显示完整配置选区和中文手工提示；`artifacts/ui-agents/mcp-600.png` 窄窗口配置和控件可见，无横向溢出。Agent 脚本另检查 1480、1165、600 宽度、底部可达和状态栏。报告位于 `artifacts/ui-agents/report.json`、`artifacts/desktop/development-report.json` 及 `artifacts/desktop/storage-report.json`。

## 交付范围

只读核对当前进程：用户运行已安装的 StudySelf，13895 未监听。本轮未启动空白预览替换用户入口，未操作真实笔记、授权、外部 Skill 安装或同步配置。修复存在于源码和构建的开发界面，现有安装程序尚未更新；当前可手动选中地址或配置按 Ctrl+C。

未运行全量核心测试或打包测试；未生成安装包、提交、推送或发布。本次只改复制界面和共用复制工具的异常清理，不涉及核心存储/协议迁移。
