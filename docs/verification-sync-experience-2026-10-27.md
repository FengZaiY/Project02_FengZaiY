# 多电脑同步体验验证

日期：2026-10-27。环境：Windows、Node 24.16.0，0.1.10 源码工作区。

## 范围

优化发送/接收布局、状态操作、配置与诊断折叠、并发冲突入口、防重复提交和局部刷新。使用原有同步业务入口，不修改同步格式、核心存储或权限。保留工作区既有修改；并行的交互阅读退役及其协议变化不属于本任务。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm test` | 314 项通过 |
| `node --test tests/sync-ui-state.test.mjs` | 3 项通过 |
| `npm run build` | 通过 |
| `npm run test:sync-ui` | 通过 |
| `npm run test:ui` | 通过 |
| `npm run test:sync-publication` | 通过 |
| `npm run test:devices` | 通过 |
| `node scripts/test-revision-integrity-ui.mjs` | 通过 |
| `npm run test:desktop` | 源码桌面及目录迁移/重启通过，使用隔离工作区 |
| `npm run check:project` | 95 个必需文件、154 篇文档、232 个本地链接、脚本契约及锁文件一致性通过 |

同步专项创建隔离双工作区，覆盖未配置禁用、首次配对、配置输入跨操作保留、16 MB 批次与冻结任务复用、上传确认取消和显式确认、缺失传输对象、仅索引后完整接收、记录已合并与原件到齐分离，以及双方并发修改保留和冲突入口。延迟扫描期间重复操作只执行一次；切换并编辑笔记后迟到结果保留原编辑器节点及文字。

视口宽度 1464、1220、931、600 均检查无横向溢出、纵向滚动和底部诊断可达。人工检查最终宽屏与 600 截图；宽屏两列，窄窗口纵向排列。清单占用专项覆盖阻塞、暂停、旧清单保留和重试。

成果位于本机忽略目录：`artifacts/ui-sync/report.json`、`overview-{width}.png`、`details-{width}.png`；`artifacts/sync-publication-ui/report.json`；`artifacts/desktop/development-report.json`、`storage-report.json`。这些截图使用隔离测试内容。

## 原预览与数据

恢复前 13895 未监听。确认原目录为 `G:\Project02_StudySelf\.local\preview-0.1.1`，无存储重定向、无未保存标签、无交互页面记录；沿用该目录在 13895 启动预览。

只读审计事件、版本头、附件绑定及选定配置，私密配置仅参与摘要、不输出内容。前后均为 7 条事件、知识库“测试”，摘要均为 `f7d116266d8ba6a629378044d63878dfe9a672bac99db80f0516aa6d6e7d47d2`。另外核对运行时实际根目录与所服务 JS 的构建摘要。

本机记录：`artifacts/sync-preview-before-20261027.json`、`sync-preview-after-20261027.json`；只读脚本 `artifacts/verify-sync-preview-20261027.mjs`。服务日志为 `artifacts/sync-preview-20261027.out.log` 和 `.err.log`。

## 边界

未使用正式笔记做测试，未操作真实百度上传或确认其云端状态。未执行两台物理电脑联调、真实安装/升级或安装包验证；已安装的 `H:\StudySelf\StudySelf.exe` 未替换。本轮未提交、推送、打包或发布。
