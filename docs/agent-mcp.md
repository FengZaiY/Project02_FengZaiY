# 外部 Agent 的 MCP 接入

FengZaiY 提供本机 Streamable HTTP MCP 服务，服务器名为 `FengZaiY`，工具前缀为 `FengZaiY_`。应用保持运行；连接与当前工作区绑定，桌面工作区和开发预览可能拥有不同地址、资料及凭证。不要使用浏览器预览端口猜测 MCP 地址。

新具名工具可直接读写任务、项目、账号非秘密信息、订阅、资金账户、账目、预算和资料集合；每次写入保留请求 ID、当前偏好及基础版本，支持事务批次。密码、恢复码和秘密备注须本机解锁后通过专用接口读取；主密码及密码库恢复密钥只在本机输入。新增 operation_catalog、operation、operation_result，支持管理功能请求及结果查询；删除、撤回、授权和系统变更须本机确认。完整字段与金额规则见 [内置 API 协议](../skills/fengzaiy/references/api.md)。新业务及密文使用 format 7；新命名链接或导图元数据需要 format 8，全部电脑须升级。

## 首次连接

1. 在“外部 Agent”页开启“启用本机 MCP 连接”。
2. 为每个客户端单独新建授权，填写名称和有效天数即可。凭证可访问全部当前及后续新建知识库（含敏感资料），具备读取、收集、提交方案、直接编辑、创建关联及请求移入回收站能力。
3. 保存仅显示一次的访问凭证，不放进笔记、公共聊天、源码仓库或同步目录。
4. 在“MCP 连接”区复制实际地址或客户端配置。配置示例不含真实凭证。
5. 在外部客户端添加服务器，然后只调用 `FengZaiY_bootstrap` 和 `FengZaiY_libraries` 验证连接与范围。此过程不需要调用付费模型 API 或创建测试笔记。

## Codex

使用界面生成的 TOML，合并到个人 Codex 配置中，不覆盖其他 MCP 配置：

```toml
[mcp_servers.FengZaiY]
url = "http://127.0.0.1:<页面显示的端口>/mcp"
bearer_token_env_var = "FENGZAIY_AGENT_TOKEN"
```

在启动 Codex 的本机环境中配置 `FENGZAIY_AGENT_TOKEN` 后重新启动客户端。这是 MCP 客户端进程使用的变量，仅配置工具子进程的 `shell_environment_policy.set` 不能代替 MCP 认证环境。已有同名变量可能用于其他工作区，须核对或为不同 MCP 实例使用不同变量名。不要求安装 Node 或运行 `client.mjs`。

## WorkBuddy 及其他 MCP 客户端

选择 Streamable HTTP，填写完整 `/mcp` 地址，并在认证/请求头配置中设置 `Authorization: Bearer <独立授权凭证>`。界面提供通用 `mcpServers` JSON，具体导入字段以客户端实际支持为准；不会自动检测或修改其安装目录。

仅支持 stdio、旧 HTTP+SSE、云端执行或强制 OAuth 的客户端不能直接使用本接口；浏览器跨域请求也会被拒绝。普通豆包客户端能否添加自定义本机 MCP 需其自身支持，不能通过把地址或凭证发到聊天中代替接入。

## 日常整理

可安装“系统设置 → SKILL 管理”导出的 `fengzaiy`，并要求 Agent 先读取 `FengZaiY_bootstrap` 的最新 Skill、协议和偏好。每批写入前再次读取。请求示例：

> 读取授权知识库的待处理草稿，结合已有笔记构思知识体系，融合出处并保留不同观点，提交待确认整理方案，暂不直接修改正式笔记。

Agent 通过 `FengZaiY_propose` 同时提交笔记内容/上下级 items 和资料分类/主题/可读文件名 materialItems。用户在“整理方案”预览正文、依赖和实际本机路径并可部分确认；未确认部分可交给 Agent 局部重做。系统负责目录、校验及绑定，Agent 不直接在工作区建文件。写入自动保留修改历史，不自动发布同步。新增资料结构使用 format 9，同步电脑须共同升级。

## 状态与限制

- “最近访问”记录实际业务方法、结果与授权名称；撤销时删除对应授权、访问记录及请求回执，保留已整理知识。旧版已撤销项启动时清理；旧有效凭证升级至全部知识库及现有 Agent 读写范围，有效期不变。撤销或到期后，已有 MCP 客户端的下一次请求也被拒绝。
- 旧 `/v1/rpc` 已停用，只能使用 MCP。已安装的旧 Skill 脚本需要更新；新版脚本也走 MCP，地址与界面显示的 `/mcp` 一致。
- 单次 assetRead/assetWrite 上限保留 16 MiB；大文件可使用 assetUploadStart/Chunk/Status/Finish/Cancel，最多 4 MiB 分块，按 received 续传，完整校验前不入库。上传会话属于当前凭证，授权撤销后拒绝继续访问；自动暂存清理仍有待完善。
- `isError: true` 是失败，不能宣称完成。冲突或偏好变化须重读，不能自动覆盖。重试同一次写入使用原 requestId 和原参数。
- 配置、确认入库、永久删除、设备与密钥管理通过 operation 请求，由用户在“外部 Agent → 操作请求”审核；Agent 不能自行批准。密码专用读取须本机解锁，主密码与恢复配置留在本机流程。服务不会代替外部 Agent 管理模型或推理费用。
- 修改服务端代码后须重启预览/桌面进程。已安装旧版需另行发布升级；本次开发不生成安装包。

协议字段见 [Skill API](../skills/fengzaiy/references/api.md)。当前验证范围见 [MCP 全功能验证](verification-mcp-full-capabilities-2026-10-28.md)；此前边界与初版协议验证分别保留在 [统一权限验证](verification-mcp-only-2026-10-23.md) 和 [MCP 验证记录](verification-agent-mcp-2026-10-21.md)。

## 旧配置切换

新配置服务器键为 `FengZaiY`，工具前缀为 `FengZaiY_`，凭证变量为 `FENGZAIY_AGENT_TOKEN`。原授权仍有效，无需因为改名重新发放凭证；脚本临时兼容旧环境变量。宿主应刷新工具发现，重新安装当前导出的 `fengzaiy` Skill 后开启新会话。旧目录安装会在系统设置提示更换目录，不自动扫描、改写外部 MCP 配置或搬动其他应用目录。
