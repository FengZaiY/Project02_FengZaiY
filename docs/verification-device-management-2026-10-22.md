# 主力机设备管理验证

日期：2026-10-22。环境：Windows、本地 Node/Electron 源码与 Playwright 隔离资料。源码版本 0.1.5；本次未生成安装包、提交、推送或修改既有 Release 草稿。

## 验证范围

主力机管理设备名称、停用/恢复及转移；管理记录权限、幂等、事务、并发与 format 5 兼容；双目录同步、原件保护、界面及源码桌面。测试不使用正式笔记，不自动改变真实设备角色或发布真实同步内容。

## 自动化结果

| 命令 | 本轮结果 |
|---|---|
| `node --test tests/device-management.test.mjs` | 8/8 通过 |
| `node --test tests/current-sync.test.mjs` | 19/19 通过 |
| `npm test` | 259/259 通过，约 191 秒 |
| `npm run build` | 通过，包含最终窄屏样式 |
| `npm run test:devices` | 通过，1220、931、600 宽度 |
| `npm run test:ui` | 通过 |
| `npm run test:desktop` | 沙箱首次启动未取得窗口；正常桌面权限重跑通过 |
| `node --test tests/agents.test.mjs tests/agent-mcp.test.mjs` | Skill 文档更新后补跑，22/22 通过 |
| `npm run test:skills` | 通过 |
| `npm run check:project` | 通过，96 个必需文件、116 份文档、172 个本地链接及脚本/锁文件契约 |
| `git diff --check` | 通过 |

设备核心覆盖主力机专属权限、过期确认、重复请求、事务回滚、暂停与恢复、离线修改保留、忽略被停用发布方、接管原件缺失、目标冒用、取消与冻结发布失效、并发名称/状态冲突、伪造操作者、循环父记录、标识碰撞及格式降级拒绝。离线接管与取消并发形成角色争议，明确恢复后继续。

源码桌面首次运行失败于 `electronApplication.firstWindow`，进程在窗口创建前关闭；以正常桌面权限重跑通过 SQLite、受限 IPC、加密、富内容、媒体、目录选择取消、迁移重启及资料保留。该重跑未关闭应用安全设置。

界面截图位于 `artifacts/devices-ui/devices-1220.png`、`devices-931.png`、`devices-600.png`；检查宽屏与窄屏实际截图，600 宽度的操作列纵向排列，控件完整可达。机器结果见 `artifacts/devices-ui/report.json`。

## 原预览核对

原入口 `http://127.0.0.1:13895/` 沿用 `.local/preview-0.1.1`。重启前确认无同步任务、目录维护、待切换目录或持久化未保存标签；核对进程命令和工作区占用锁后，仅重启该预览进程，以正常运行权限保留已配置同步目录的访问能力。

`node artifacts/verify-device-preview.mjs --after` 比对通过：6 条事件、全部 heads，以及角色/管理、授权、配对和同步目录相关本机配置的摘要更新前后一致。证据为 `artifacts/device-preview-before.json` 和 `artifacts/device-preview-after.json`，不含凭证明文或笔记正文。浏览器重载后仍有“测试”知识库和“车市”工作标签；设备页显示两台设备的短标识与启用状态，仍未设置主力机，未点击设定或执行任何真实管理操作。

## 边界

- 管理状态需经现有发布/接收流程传播；未自动发布或重试既有同步任务。
- 停用依赖更新客户端执行，不是共享密钥撤销、远程擦除或对离线电脑的即时控制。
- 新管理清单为 format 5，参与同步的电脑须一起升级；保留旧格式读取，但旧客户端不能处理管理清单。
- 实际跨物理电脑、百度客户端上传及云端状态未实测；双目录测试不等同真实部署。
- 既有 0.1.5 安装包未重建，不能据相同版本号认定已包含本次源码改动。
