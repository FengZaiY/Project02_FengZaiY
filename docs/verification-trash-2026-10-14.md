# 清空回收站验证

日期：2026-10-14。Windows，Node.js 24.16.0，源码开发预览，无安装包。

## 已执行

- `node --test tests/trash.test.mjs`：7 项通过。范围、引用及依赖保护、未保存草稿、156 项批量、回滚、过期确认、乱序/重复/重启、并发恢复、v3 新机接收和标记完整性。
- `npm test`：首次 159 项中 158 通过；既有 Agent 回执测试因随机端口被 Node fetch 拒绝（`bad port`）失败。该项单独重跑通过，随后全量 159 项通过，日志在 `artifacts/trash-ui/core-tests.log`。未修改无关端口策略。
- `npm run build`：通过。
- `npm run test:trash`：通过。当前库范围不受搜索限制、取消不写入、过期预览拒绝、保护条目保留、空结果禁用、清空标签关闭。检查 1220/600 宽度截图，确认按钮可达、文字无遮挡。
- `npm run test:ui`、`npm run test:assets`、`npm run test:libraries`、`npm run test:hierarchy`、`npm run test:agents`：通过。
- `npm run test:desktop`：首次受限环境图形进程退出并导致 `ERR_FAILED`；获准在隔离资料下重跑通过，包含安全 IPC、SQLite、Windows 加密、编辑器和本机存储迁移。
- `npm run benchmark`：隔离的一万条笔记创建约 9.43 秒、汇总约 231 毫秒、列表约 291 毫秒、搜索约 327 毫秒；这是普通查询基准，不代表一万条回收内容清空性能或其他电脑性能。
- `npm run check:project`、`git diff --check`：通过。Skill 校验初次受 Windows 默认 GBK 解码影响，使用 `python -X utf8 .../quick_validate.py skills/studyself-organize` 后通过。

## 原预览

原 13895 端口按既有启动锚点与实际工作区重新启动。读取基线确认无未保存标签、同步或本地整理任务；Windows 停止命令首次失败时新进程被占用锁拒绝，未打开第二个写入实例，随后核对同一进程后完成重启。

启动前后及页面刷新、进入回收站后，16 个实体、154 条原始修改记录、全部当前分支及 7 个原文件哈希一致。未确认或执行正式资料清空，现有 3 项回收内容仍保留。原始校验结果在 `artifacts/trash-ui/preview-before.json` / `preview-after.json`，交付界面截图为 `artifacts/trash-ui/preview.png`。

## 限制

测试只用隔离资料，未操作用户正式回收内容。清空是不可从普通界面恢复的逻辑终止，不是物理擦除；原文件、旧同步链和云端历史不删除。并发远端恢复仍按冲突保留。没有执行真实百度客户端或双机部署联调；自动化覆盖本系统 v3 双目录传输。旧客户端需更新以识别 `purged` 字段。

未重跑与此次回收站无直接关系的全文编辑体验、富内容、正文流、资料缩略图专项和安装包测试。超大回收站引用扫描暂无专项性能保证。
