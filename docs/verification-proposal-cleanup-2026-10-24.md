# 已确认整理方案清理验证

日期：2026-10-24。环境：Windows、Node v24.16.0；仅使用 `artifacts/` 下隔离资料和源码桌面实例。

## 结果

- `node --test tests/draft-workflow.test.mjs`：14 项通过。新增确认方案回收/重试/恢复、原件哈希及笔记身份保留、空方案/部分确认/过期版本/未保存/并发拒绝、永久清空依赖保护、完整依赖组清空；扩展双目录同步及 MCP 禁止调用检查。
- `npm test`：312 项通过，无失败。完整日志：`artifacts/proposal-cleanup-core.log`。
- `npm run build`：通过，仅开发界面构建。
- `npm run test:drafts`：通过。取消不变更、全部确认后替换操作入口、查看入库笔记、清理后列表移除、恢复不重复入库、草稿仍已处理；覆盖 1304、1001、600 宽度，检查无横向溢出，截图已查看。调整完成状态标签对齐后重新运行通过。
- `npm run test:trash`、`npm run test:ui`：通过，原有清空范围/取消/过期确认/引用保护及通用编辑同步回归保留。
- `npm run test:desktop`：首次隔离运行在窗口创建时关闭；以允许启动本地进程的权限重新运行通过，未降低 Electron 沙箱。覆盖源码启动、IPC、编辑器及迁移回归，未测试新安装包。
- `python -X utf8 C:/Users/Administrator/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/studyself-organize`：通过。首次不带 UTF-8 参数时受 Windows 默认 GBK 解码失败，改执行参数后通过，未改验证器。

## 预览与边界

原 `http://127.0.0.1:13895/` 已沿用 `.local/preview-0.1.1` 重启。更新前确认无持久化未保存标签、同步空闲且根目录匹配；更新后只读检查及无效 ID 调用验证新接口，不创建或清理正式方案。前后均为 7 条事件、2 个版本头、0 个附件绑定，摘要均为 `2ecdeb10d2249be213c02b38e4e1cca79aeadd090ae7183d4ccbb2c9ce4b433a`。证据：`artifacts/proposal-cleanup-preview-before.json`、`artifacts/proposal-cleanup-preview-after.json`。

清理表示移入回收站，不自动永久清空。有效的草稿确认依据按历史引用保护；完整依赖组均可删除时可一起清空。协议字段不变，但其他设备需要更新才能执行新增永久删除保护；无法恢复旧客户端已经删掉的唯一确认依据。真实百度双机部署、已安装桌面版本均未验证；未提交、推送、打包或修改版本号。

主要截图：`artifacts/ui-draft-workflow/proposal-complete-1304.png`、`proposal-complete-600.png`、`proposal-cleanup-confirm.png`。
