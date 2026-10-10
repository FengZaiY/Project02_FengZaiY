# 目录选择验证

日期：2026-10-09。环境：Windows、Node.js 24.16.0、当前开发源码；不生成安装包。

## 改动与结果

根目录、迁移和打开已有工作区先调用系统文件夹窗口，选择后的路径只读展示，支持重新选择；检查及二次确认仍然保留。取消不会提交变更，目录按钮不再打开手工路径输入框。同步、备份和恢复使用同一选择器。Windows 预览仅通过本机界面鉴权接口调用固定 STA 脚本，外部 Agent 无此能力。

| 本轮检查 | 结果 |
|---|---|
| `npm test` | 84 项通过；含新增 4 项目录选择测试 |
| `node --test tests/directory-picker.test.mjs` | 最后补充预取消保护后重跑，4 项通过 |
| `npm run build` | 通过，最后界面修改后重新构建 |
| `npm run check:project` | 通过：35 个必需文件、27 份文档、45 个本地链接及命令/锁文件检查 |
| `git diff --check` | 通过；仅提示已有 `.gitignore` 的换行转换 |
| `npm run test:ui` | 通过 |
| `npm run test:libraries` | 通过 |
| `npm run test:storage` | 通过；修正两个测试导航定位器后重跑成功 |
| `npm run test:desktop` | 通过；隔离资料验证 Electron 选择回调、取消、重启迁移和密钥保留 |
| 真实 Windows 选择进程 | 固定脚本启动，进程有窗口句柄且响应正常；主动中止后退出，无目录变更 |
| 原预览服务 | 同一端口重启，启动前确认无脏标签、待迁移、同步或 Agent 活动；根目录、知识库 ID/版本和内容数量一致 |

新增测试覆盖：结构化中文路径、取消、异常结果、不支持的平台、进程失败、重复请求、预取消、页面断开、服务关闭、错误令牌、Host/Origin 拒绝，以及受信任业务入口不包含系统选择方法。界面测试覆盖三个存储入口、重选、失败重试、取消保留路径、未保存编辑保护及同步/备份目录回填。

已查看 `artifacts/ui-storage/directory-selected-1165.png`、`directory-selected-600.png` 和 `artifacts/desktop/storage-migrated-window.png`，对话框无重叠，检查按钮可达；宽窄视口和底部可达断言通过。

## 未验证范围

- 原生窗口外观与真实选择/取消按钮点击未完成：Computer Use 和浏览器交互工具初始化遇到本机沙箱 helper 故障。进程启动/终止冒烟不等于完整原生交互验收；自动化界面测试使用模拟选择返回值。
- `test:agents`、`test:rich` 本轮未运行；外部 Agent HTTP 与富内容核心测试包含在 `npm test` 内。
- 安装包、百度网盘真实双机、真实付费服务均未运行。未改用户存储位置或代选目标目录；未生成安装包或提交 Git。
