# README 与状态摘要校正验证（2026-11-02）

环境：Windows PowerShell，项目源码版本 0.1.19。仅修改文档，未启动或写入用户工作区。

## 核对范围

- [README](../README.md) 与[项目状态](project-status.md) 的现行接入、授权、文件布局及能力边界。
- 对照 `src/core/agent-access.mjs`、`agent-mcp.mjs`、`agent-operation-catalog.mjs`：唯一外部入口为 `/mcp`，有效凭证统一范围，固定管理操作须本机审核。
- 对照 `src/core/agent-uploads.mjs` 及内置 API 协议：单次文件读写仍限 16 MiB，上传支持最多 4 MiB 分块及续传，不能推导为已有大文件分块读取。
- 对照 `src/core/service.mjs`、`workspace-layout.mjs`、`local-hierarchy.mjs`、`readable-storage.mjs`：新建/已迁移工作区的内部数据库、富内容 JSON、接收暂存及可读原件目录；旧布局继续兼容，升级不等于完成迁移。
- 对照 `src/core/skill-installations.mjs` 和对应界面：仅管理已关联位置，默认提醒后确认，可显式开启自动更新。
- 保留历史发布地址和验证结果，给旧轮次及早期验证摘要增加适用范围说明，不把旧测试数量作为本轮结果。

## 验证结果

- `npm run check:project`：通过，检查必需文件、文档链接、脚本契约及锁文件一致性。
- `git -c safe.directory=G:/Project02_FengZaiY diff --check`：通过。仅为本次命令指定仓库目录信任，未修改全局 Git 配置。
- 定向搜索确认两份文档不再包含“不提供 MCP”“不是 MCP”“需要额外勾选”“暂无分块 Agent 文件接口”等旧现行说明。

未运行核心、界面、桌面及依赖审计测试；未构建安装包、迁移资料或验证第三方客户端。文档检查不代表新增功能测试或真实部署验证。
