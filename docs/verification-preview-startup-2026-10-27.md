# 本机预览白屏修复验证

日期：2026-10-27。Windows、Node 24.16.0、Electron 42.11.12。

## 原因与修复

用户的 13895 页面显示 FengZai·Y，但旧 Node 进程 535832 的 state 返回 0.1.10；新 personalDraft 调用返回 `{message: "Unsupported operation", code: "ERROR"}`。浏览器原页同样只剩这条错误。构建更新了磁盘静态文件，已运行的后端模块仍留在内存中。此前源码升级没有同步重启这个原预览入口，是本次交付遗漏。

新增独立可信界面协议编号，前端在 state 后立即校验，旧服务不能继续初始化新版业务。版本不匹配、网络失败及其他启动异常显示持续可见的中文恢复页和“重新加载”，错误详情按纯文本展示。失败不自动写入空工作区或跳过本机草稿。更新开发说明和项目约定，明确后端修改须按原参数重启并核对真实页面。

## 原工作区恢复

只读核对原端口、进程命令、目录、锁、存储配置及业务状态：原目录 `.local/preview-0.1.1` 存在数据库，无待应用存储变更、未保存标签、同步/目录维护活动，也没有已关联 Skill。只重新启动已确认的旧预览进程，未停止其他 Node、Electron 或客户端进程；新进程 562900 继续使用相同目录和 13895 端口。

恢复后 state 返回 0.1.11、uiProtocol 1，personalDraft 正常读取。已在用户原浏览器标签重新加载，核对五板块导航、原“测试”知识库和笔记正常显示。事件、版本头、附件绑定以及排除后台投影维护状态的全部本机配置摘要均与重启前一致，页面重新加载后再次核验仍一致。前后证据：`artifacts/preview-startup-before.json`、`preview-startup-after.json`、`preview-startup-verified.json`，恢复截图：`artifacts/startup-ui/live-preview-recovered.png`。

## 本轮验证

| 命令 | 结果 |
|---|---|
| npm run build | 通过；startup-repair-build.log |
| npm run test:startup | 通过；旧后端、网络/初始化错误、安全详情、重试、草稿保留及 600 宽窗口；startup-repair-ui.log |
| npm run test:personal | 通过；startup-repair-personal.log |
| npm run test:ui | 通过；startup-repair-general.log |
| npm run test:desktop | 通过；原生启动、安全 IPC、媒体、凭据及目录迁移重启；startup-repair-desktop.log |
| npm test | 340 项通过，0 失败/取消/跳过；startup-repair-core.log |
| npm run check:project / git diff --check | 通过；95 个必需文件、162 份文档、245 个本地链接；startup-repair-project.log |

测试使用隔离目录；实际预览仅执行只读核验、已知空闲进程重启和页面重新加载，未修改笔记、授权或同步配置。已查看旧后端窄窗恢复页及用户原页面恢复截图。未打包、更新安装版、提交或推送。本次白屏是已定位的前后端版本不一致问题，不将此前 Electron 原生异常认定为同一原因或已经解决。
