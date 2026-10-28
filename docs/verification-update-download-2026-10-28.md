# 更新下载控制验证

日期：2026-10-28。Windows、Node 24.16.0，源码 0.1.13；运行依赖以锁文件为准。仅使用 `artifacts/` 隔离资料、本机测试源与不可执行载荷，不运行安装程序或下载真实发布文件。

## 已通过

- `node --test --test-concurrency=2 tests/*.test.mjs`：363 项通过，0 失败/取消/跳过；日志 `artifacts/update-controls-core.log`。
- `node --test tests/updates.test.mjs tests/update-download.test.mjs`：13 项通过。真实 NSIS 更新库验证取消、Range 续传、重新下载、损坏文件拦截；单独传输覆盖网络中断、错误范围、忽略 Range、416 回退、错误校验、取消前启动、非法重定向及无关缓存保护。
- `npm run build`、`npm run test:updates`、`npm run test:ui`：通过。更新 UI 覆盖重复点击、暂停/继续/重下载、失败重试、迟到事件、切页、未保存保护及开发预览禁止调用。查看 `artifacts/ui-updates/downloading.png` 和 `paused-600.png`，按钮和文字无裁切；另生成 1001/1304 宽度截图。
- `npm run test:desktop`：正常本机进程环境通过源码启动、安全 IPC、原生媒体、加密、目录选择及重启迁移。未执行真实升级安装。
- `npm run test:updates-desktop`：真实 Electron `net.fetch` 终止请求、保留断点、新控制器按字节续传、从零重新下载及最终文件校验通过；记录在 `artifacts/update-download-desktop/report.json`。
- `npm ls builder-util-runtime`：直接依赖 9.7.0 已存在，锁文件只增加根依赖声明，无版本升级。项目结构/本地链接/锁文件一致性检查及 `git diff --check` 通过。

## 失败与限制

- 首次源码桌面测试在受限环境中于 `firstWindow` 报 `Target page, context or browser has been closed`。用户同轮提供 Electron `0x80000003` 弹窗。正常本机环境重跑通过；未获得足以解释原生异常的调用栈，不把复跑结果当成根因定位或崩溃修复。没有为通过测试关闭应用安全沙箱。
- 下载专项首稿通过 Playwright evaluate 动态 import 失败；改为独立 Electron 测试入口。随后发现 ESM 顶层等待 ready 阻止入口加载完成，改为 ready 回调后通过；这两处为测试入口问题，不在产品启动代码中。已停止挂起的隔离测试进程。
- 离线 npm install 因本机缺少 registry 缓存失败；所需 9.7.0 已安装且锁文件存在，显式补充直接依赖后通过依赖和锁文件检查。
- 暂停状态本身不跨重启恢复；重新检查并请求同一安装文件可复用断点。不同版本残留断点暂不自动清理。使用完整安装包，复制校验期间可能占两份安装文件空间。
- 浏览器预览不支持在线下载安装；本轮未切换用户预览根目录、操作正式工作区或修改已安装版本。实际 GitHub 网络、签名/提权和跨版本安装仍由独立发布任务验证。
- 未提交、推送、打包、修改版本或发布内容。保留任务开始前已存在的发布文档修改。
