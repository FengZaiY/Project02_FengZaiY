# 外部 Agent 的 MCP 接入

StudySelf 提供本机 Streamable HTTP MCP 服务。应用保持运行；连接与当前工作区绑定，桌面工作区和开发预览可能拥有不同地址、资料及凭证。不要使用浏览器预览端口猜测 MCP 地址。

## 首次连接

1. 在“外部 Agent”页开启“允许本机外部 Agent 访问”。
2. 为每个客户端单独新建授权，选择可访问的知识库。默认允许读取、收集和提交待确认方案；直接编辑、移入回收站及敏感资料另行授权。
3. 保存仅显示一次的访问凭证，不放进笔记、公共聊天、源码仓库或同步目录。
4. 在“MCP 连接”区复制实际地址或客户端配置。配置示例不含真实凭证。
5. 在外部客户端添加服务器，然后只调用 `studyself_bootstrap` 和 `studyself_libraries` 验证连接与范围。此过程不需要调用付费模型 API 或创建测试笔记。

## Codex

使用界面生成的 TOML，合并到个人 Codex 配置中，不覆盖其他 MCP 配置：

```toml
[mcp_servers.studyself]
url = "http://127.0.0.1:<页面显示的端口>/mcp"
bearer_token_env_var = "STUDYSELF_AGENT_TOKEN"
```

在启动 Codex 的本机环境中配置 `STUDYSELF_AGENT_TOKEN` 后重新启动客户端。这是 MCP 客户端进程使用的变量，仅配置工具子进程的 `shell_environment_policy.set` 不能代替 MCP 认证环境。已有同名变量可能用于其他工作区，须核对或为不同 MCP 实例使用不同变量名。不要求安装 Node 或运行 `client.mjs`。

## WorkBuddy 及其他 HTTP 客户端

选择 Streamable HTTP，填写完整 `/mcp` 地址，并在认证/请求头配置中设置 `Authorization: Bearer <独立授权凭证>`。界面提供通用 `mcpServers` JSON，具体导入字段以客户端实际支持为准；不会自动检测或修改其安装目录。

仅支持 stdio、旧 HTTP+SSE、云端执行或强制 OAuth 的客户端不能直接使用本接口；浏览器跨域请求也会被拒绝。普通豆包客户端能否添加自定义本机 MCP 需其自身支持，不能通过把地址或凭证发到聊天中代替接入。

## 日常整理

可安装“系统设置 → SKILL 管理”导出的 `studyself-organize`，并要求 Agent 先读取 `studyself_bootstrap` 的最新 Skill、协议和偏好。每批写入前再次读取。请求示例：

> 读取授权知识库的待处理草稿，结合已有笔记构思知识体系，融合出处并保留不同观点，提交待确认整理方案，暂不直接修改正式笔记。

Agent 通过 `studyself_propose` 提交内容、上下级或交互页面方案。用户在“整理方案”预览并可部分确认；未确认部分可交给 Agent 局部重做。写入自动保留修改历史，不自动发布同步。

## 状态与限制

- “最近访问”记录实际业务方法、结果与授权名称；已授权列表可撤销授权。撤销或到期后，已有 MCP 客户端的下一次请求也被拒绝。
- 单附件读写上限仍为 16 MiB，不因换协议而扩大；大文件由界面导入或提供提取结果。
- `isError: true` 是失败，不能宣称完成。冲突或偏好变化须重读，不能自动覆盖。重试同一次写入使用原 requestId 和原参数。
- 配置、确认入库、永久删除、设备与密钥管理不开放给 MCP。服务不会代替外部 Agent 管理模型或推理费用。
- 修改服务端代码后须重启预览/桌面进程。已安装旧版需另行发布升级；本次开发不生成安装包。

协议字段见 [Skill API](../skills/studyself-organize/references/api.md)。本轮验证范围见 [MCP 验证记录](verification-agent-mcp-2026-10-21.md)。
