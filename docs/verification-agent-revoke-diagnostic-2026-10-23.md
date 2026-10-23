# 撤销授权后 Electron 报错排查（2026-10-23）

用户在确认撤销外部 Agent 授权后看到 Windows 的 `electron.exe` 应用程序错误，异常码 `0x80000003`；用户反馈关闭错误框后正式程序未整体退出。排查期间又出现同样的错误框。

## 证据与处理

- 只读检查进程：正式程序为 `H:\StudySelf\StudySelf.exe`（PID 85688）；另有仓库 `node_modules\electron\dist\electron.exe` 的桌面测试进程，启动参数带 `--smoke-test` 和 `artifacts/desktop/profile-XW1IPl`。该测试目录创建于本机时间 13:05:01。
- 本轮隔离桌面诊断分别使用 `artifacts/agent-revoke-desktop/profile-5LSFJ9`、`profile-g8Ds72`。前者 Electron 启动超时；后者在等待界面初始化时失败，尚未建立测试授权或执行撤销。用户在这段时间再次反馈相同的 `electron.exe` 错误。因此不能将新弹窗归因于撤销授权。
- 停止了经可执行路径、`--smoke-test` 和隔离目录三项核对的测试进程，没有停止正式 `StudySelf.exe`，没有修改真实资料或授权。清理后残留进程条目的句柄数、虚拟内存均为 0；不再启动 Electron 复现。
- 系统应用事件中未找到与原截图对应的崩溃记录。最初弹窗可能来自旧桌面测试残留，但尚无转储/堆栈可证明其内部原因。正式进程存在不等于其全部界面交互已经复测。
- `AgentAccess.revoke()` 仅持久化授权的撤销状态并返回状态，不关闭窗口或退出进程。本轮没有依据去更改授权、安全设置或依赖版本。

## 验证

- `npm run build`：通过。
- 正常本机回环环境执行 `node --test --test-timeout=30000 --test-name-pattern='revoc|revok|credentials|MCP exposes' tests/agents.test.mjs tests/agent-mcp.test.mjs`：5 项通过，0 失败。覆盖 HTTP/MCP 撤销、旧回执重放前重验授权，以及凭证本机隔离。
- 受限环境最初执行的完整 Agent 核心测试未及时返回，已停止；不记作通过。
- `node scripts/test-agents-ui.mjs`：在第 118 行点击设置时超时，尚未到第 187 行的撤销流程；本轮不记作界面通过。
- 本轮桌面专项未通过，不能声称桌面崩溃已修复。临时诊断脚本已移除，仅保留隔离测试成果和此记录。

未修改产品源码，未提交、推送、生成安装包或更改已安装程序。后续如正式 `StudySelf.exe` 自身复现，应以该进程的日志/转储继续定位；不得以另一进程的相同窗口标题作为授权故障证据。
