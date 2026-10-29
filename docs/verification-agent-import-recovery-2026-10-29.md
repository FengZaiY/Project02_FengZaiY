# 导入反复报错复查

日期：2026-10-29；Windows、Node 24.16.0、源码版本 0.1.17。续接 [上一轮验证](verification-agent-import-2026-10-29.md)，保留已有全部修改及其他发布任务文档。

## 实际运行差异

只读检查进程确认安装版主进程 PID 751868，入口 `H:\FengZaiYAPP\FengZaiY.exe`。使用已有 @electron/asar 读取包内 package.json 和 agent-operations.mjs：版本 0.1.17，含 checkedAt 排除修复，不含 asset-import-v1、async recheck 或具体失效原因。源码包含这些功能。生成的无凭证对比记录为 `artifacts/agent-import-installed-comparison.json`。没有停止安装版、解密正式请求或修改其包。

首次 ASAR 读取使用斜线模块名，Windows 归档解析报路径不存在；按平台 path.join 改用原归档条目路径后成功。可执行文件 VersionInfo 返回 Electron 的 42.11.12，产品版本以实际包内 manifest 为依据，未误报为应用版本。

这些证据说明当前安装版仍会使用旧的全库失效规则；没有读取原队列及其历史状态，不能断定每次截图由哪一笔修改触发。前一轮源码修复并未进入已经固定的 0.1.17 安装包。

## 本轮补齐

- 新导入加密请求保存各相关字段摘要，用于说明目标知识库、本地存储、授权或偏好变化。无旧摘要时保留兼容检查并说明原因范围未知，不伪造历史。
- 预览直接阻止失效授权、偏好变化或冲突；到期请求明确说明须新发起。
- 确认遇到状态冲突只重新读取预览，不重发业务操作，不沿用旧确认令牌；须用户再次点击确认。文件缺失后恢复可手动刷新。
- 以当前弹窗内容标识隔离迟到响应，关闭/替换后不重新打开旧弹窗，旧按钮收尾不操作新弹窗。
- 不修改请求参数、到期时间、同步格式、偏好基线或安装程序。其他高风险管理操作不放宽全局快照。

## 验证

- `node --test tests/agent-operations.test.mjs`：13/13。增加存储/授权失效原因、无关授权不影响导入、操作管理器重新创建后快照保持、到期明确提示等断言，保留原文件/目标/偏好/幂等/撤销保护。
- `npm run build`、`npm run test:agent-operations`：通过。连续三次在确认前修改文件均刷新预览且未自动导入，最终显式确认一次；删除后恢复文件经刷新可继续；人工延迟详情响应再关闭弹窗，响应不重开窗口。已有多文件导入、旧请求重新核对、拒绝、密码及宽窄布局断言保留。
- `npm run test:agent-operations-desktop`：通过，真实 Electron/MCP/IPC 仍须单独确认，未执行安装器。
- `npm run test:agents`、`npm run test:skills`、`npm run test:ui`、`npm run test:startup`、`npm run test:desktop`：通过；桌面含隔离存储迁移及凭据保护。
- Skill quick_validate：通过。已查看 `artifacts/ui-agent-operations/import-changed-refresh-600.png`，提示、文件路径和三个操作按钮无遮挡。
- 完整 `npm test`：399/399，无失败、取消或跳过，约 223 秒；日志 `artifacts/agent-import-recovery-core-tests.log`。仅为测试子进程设置 Git 信任，不修改全局配置。
- `npm run check:project`、`git diff --check`：通过。

## 预览及限制

先核对原预览 PID 771916 与 server.mjs 命令、`.local/preview-0.1.1` 实际工作区及未保存/维护状态；仅重启此进程，新 PID 775920。原“测试”库保留，版本 0.1.17、协议 4，服务 app.js 与 dist 一致，页面无错误。

`artifacts/agent-import-recovery-preview-before.json` / `after.json` 记录 events、heads、assets、同步/授权/秘密配置摘要一致；页面截图 `agent-import-recovery-preview-ready.png`。仅隔离测试文件，未批准用户真实 PDF 或改动正式资料。

安装版依然需要后续发布纳入本轮与上一轮修复；没有执行真实升级，不能宣称当前已安装程序已经修好。本轮不提交、不推送、不打包、不发布。
