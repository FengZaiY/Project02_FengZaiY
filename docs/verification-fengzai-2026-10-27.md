# FengZai·Y 个人管理系统升级验证

日期：2026-10-27。Windows 本机源码，Node 24.16.0、Electron 42.11.12；依赖沿用锁文件。所有测试使用 artifacts 内独立目录和模拟资料，不修改正式工作区、安装版或已安装外部 Skill。未提交、推送、构建安装包或发布。

## 交付范围

五板块导航及可用业务表单、独立资料集合与共享引用、集中原件与可恢复迁移、项目/子任务、账号及订阅、人民币与人工多币种财务、分类预算/资产报表、CSV 预览导入导出、独立加密密码库、具名 MCP 业务工具、用户/Agent 操作批次及整批撤回。修改记录和新实体使用 format 7；旧格式继续读取，旧客户端须统一升级。

保留原安装 appId、默认工作区锚点、旧链接和 MCP 前缀。品牌显示为 FengZai·Y。Electron 网络 User-Agent 单独使用 ASCII 的 FengZaiY，避免中点进入请求标识导致原生媒体加载失败。

## 自动化结果

| 命令 | 本轮结果与证据 |
|---|---|
| npm test | 最终完整 340 项通过，0 失败/取消/跳过；personal-final-core.log |
| node --test tests/personal-system.test.mjs | 19 项通过；personal-additional-tests.log |
| npm run build | 通过；personal-final-build.log |
| npm run test:personal | 通过，包含同板块切换、全局搜索跳转及未提交表单保护；personal-final-ui.log |
| npm run test:ui | 最终回归通过；personal-legacy-ui.log |
| npm run test:libraries | 通过；personal-libraries-ui.log |
| npm run test:assets | 通过；personal-assets-ui.log |
| npm run test:hierarchy | 通过；personal-hierarchy-ui.log |
| npm run test:drafts | 通过；personal-drafts-ui.log |
| npm run test:agents | 通过；personal-agents-ui.log |
| npm run test:skills | 通过；personal-skills-ui.log |
| npm run test:updates | 通过；personal-updates-ui.log |
| npm run test:trash | 通过；personal-trash-ui.log |
| npm run test:sync-ui | 通过；personal-sync-ui.log |
| npm run test:sync-publication | 通过；personal-sync-publication-ui.log |
| npm run test:personal-desktop | 正常本机环境通过；personal-desktop-normal.log |
| npm run test:desktop | 正常本机环境通过；personal-desktop-regression.log |
| npm run test:exit | 正常本机环境通过；personal-exit-regression.log |
| npm run test:audit-fixes | 正常本机环境通过；personal-audit-fixes.log |
| skill-creator quick_validate.py | Python UTF-8 模式通过；默认 GBK 模式首次读取中文失败，不是 Skill 格式错误 |
| npm run check:project / git diff --check | 通过；95 个必需文件、160 份文档、244 个本地链接；personal-project-check.log |

日志路径均位于仓库的 artifacts/，不纳入版本控制。早期失败日志不代表最终结果；表内命令与对应最终日志是本次交付依据。

## 关键覆盖

- 兼容：旧事件、笔记、资料 ID/哈希和历史保留；原件从旧绑定迁移，外部源保留。根目录迁移保留数据库、凭据、草稿和本机链接，并重映射待处理资料迁移路径。
- 文件失败：空间不足、模拟占用、绑定事务失败及被手改的目标文件均保留可重试任务；绑定失败不提交元数据或进度。新同步原件在接收区组装，完整校验后独占发布到集中目录；并发/坏分块不误报到齐。双目录完整套件继续覆盖断点、缺块、重复接收与引用保护。桌面显式导出默认定位独立 exports 目录，路径归属及安全文件名检查通过，准备导出位置不覆盖已有文件。
- 密码：错误主密码、独立恢复密钥、重设主密码、十分钟闲置锁定、密文草稿、密文同步、秘密并发分支与两台电脑分别初始化后的配置合并。旧秘密历史使用保留的加密历史密钥读取；普通记录、草稿及 Agent 接口不允许秘密字段。账号与密码回收/恢复/撤回一起提交，未提交秘密草稿阻止删除。
- 财务：最小单位整数及三位/零位币种、精确十进制导出、人工汇率、转账排除收支、累计退款限额、预算、CSV 重复及预览过期、订阅付款与续费日期同事务、重复付款拒绝；冲突或缺少汇率明确返回不完整。
- 批次：嵌套失败回滚、同批项目与任务撤回、订阅付款撤回、后续修改及新增引用保护、撤回结果同步，历史保留。资料重复合并保留集合归属并调整业务引用。
- MCP：官方客户端发现新工具、非秘密批次、回执重放、失败整批回滚、秘密工具与字段拒绝。既有 Host/Origin、偏好、过期/撤销和读请求中撤销检查一并运行。
- 界面：五板块、跨页表单和键盘保存、财务概览、密码设置/保存/锁定、集合、修改记录和启动位置恢复。任务和账号在同板块切换记录、全局搜索跳转均更新详情；未提交表单阻止切换其他记录。并发业务先对照后编辑；同板块导航不再重置表单；切换知识库时保留切换期间的新搜索输入。
- 桌面：实际 CSV 导出完成且内容落在工作区独立 exports 目录。原生密码复制只清理未变化的本次内容；模拟 lock-screen 锁定密码库并清空界面秘密。业务草稿加入退出保护，“保存后退出”后以只读 SQLite 检查实际任务及草稿清空。既有桌面覆盖安全 IPC、Windows 凭据、原生图像、目录选择及迁移重启。

已查看 personal-ui/tasks-desktop.png、finance-desktop.png、finance-narrow.png、personal-desktop/exit-personal-draft.png；主导航和工具区分开，桌面及 850 宽窗口无横向溢出，窄窗内容在工作区内滚动。既有测试另覆盖 600 宽窗口、底部入口、原附件和预览操作。

## 本轮发现与处理

第一次个人桌面测试在受限进程环境中未打开首窗口便退出；同期用户提供 electron.exe 的 0x80000003 弹窗。只读进程检查确认没有 Electron 残留。正常本机环境重跑通过，不能据此声称已修复所有原生崩溃，也不能把首次启动失败归因为撤销授权。

品牌改名另导致可复现的原生媒体 ERR_UNEXPECTED：磁盘读取及主进程 net.fetch 均成功，但渲染进程图片失败。隔离对照确认 User-Agent 中 FengZai·Y 改为 ASCII 后，同一文件和同一响应立即可读。已固定请求标识，保留显示名称及所有安全设置；源码桌面回归通过。诊断日志为 native-media-diagnostic.log。

新导航还暴露旧测试定位和异步输入竞态：入口改为板块内二级导航；修复同页重复导航重建、记录详情未刷新以及库切换延迟重置搜索，按新入口更新测试而不移除原行为检查。退出专项先验证重启恢复设置页，再导航回未保存草稿；继续覆盖全部标签保存、并发冲突阻止退出与进程关闭后 SQLite 实际内容。

## 边界

没有在真实家用/公司双机、百度客户端或已安装版本执行迁移。没有验证安装、签名或跨版本安装升级，沿用独立发布流程。锁屏事件用 Electron 模拟，未实际锁定用户桌面；密码清理使用真实本机剪贴板，个人专项恢复原剪贴板内容。这里是功能和回归证据，不是密码库的独立安全审计。

同步无法证明百度已上传；确认付款仅记账，不执行银行交易。旧原件迁移由用户预览确认，未知文件、外部来源及被修改副本保留；不承诺删除网盘历史或取证级擦除。未关联的外部 Skill 由用户另行更新。
