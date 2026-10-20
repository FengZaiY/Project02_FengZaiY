# 在线更新验证

日期：2026-10-20。Windows，Node 24.16.0；源码版本 0.1.1。测试使用 artifacts 内的独立工作区、模拟状态和不可执行的下载内容，未运行安装包。

## 已验证

- `npm test`：206 项通过，0 失败；日志 `artifacts/updates-core.log`。该次全量运行之后补充真实更新库下载案例及初始化失败保护，最终 `node --test tests/updates.test.mjs` 的 7 项均通过；不把增补测试冒充已包含于旧全量计数。
- 更新单元/集成：仅 HTTPS 或公开 GitHub 来源，默认仓库与发布配置一致；开发/未配置/错误配置限制，普通退出不安装、手动下载、进度、重复操作、失败恢复、旧版本事件、自动检查设置写入失败、自定义启动目录保护，以及主进程空闲条件。
- 真实 NsisUpdater 通过仅测试使用的 loopback HTTP 传输层读取版本清单；实际下载共享 HttpExecutor 进行 SHA512 校验，错误字节未进入完成状态，修正后验证文件内容。使用无可执行结构的 fixture，未调用安装。
- `npm run build`、`npm run test:updates`：预览禁用安装接口；模拟桌面更新/进度/下载完成/重试入口，跨页保留状态，说明文本转义，普通退出策略，稍后更新，未保存偏好和保存失败笔记阻止安装且正文仍在；1304/1001/600 窗口布局与截图核对。
- `npm run test:ui`：编辑、标签、范围、同步、局部确认、过期编辑回归通过。最终重跑首次分配到 Chromium 禁用的临时端口 6669，在导航阶段失败；使用重新分配的隔离端口重试通过，未放宽浏览器端口限制。
- `npm run test:skills`、`npm run test:agents`：偏好/导出/历史/未保存保护及外部 API 回归通过。核心 HTTP 测试明确拒绝所有 update 方法，浏览器预览也拒绝这些方法。
- `npm run test:desktop`：首次在执行沙箱内 Electron 创建窗口前退出；沙箱外使用同一隔离测试通过，未关闭 Electron 沙箱/隔离设置。最终源码再次复测，检查开发模式、更新 RPC 限制、自动检查偏好持久化、SQLite、安全 IPC、本机加密、正文与存储迁移。
- `python -X utf8 .../skill-creator/scripts/quick_validate.py skills/studyself-organize` 通过；默认 GBK 解码失败后改用 Python UTF-8 模式，没有改文件编码。
- `npm run check:project`、`git diff --check`：最终检查见本轮交付输出。

## 原预览与发布源

沿用原 13895 服务和已核对启动锚点，不启动空工作区替代；原页面刷新前检查没有未保存标签或偏好。更新入口在原页面可见，更新来源展示用户提供的 GitHub Releases。读校验确认 18 个实体、190 条修改记录、7 个原文件的内容及当前分支未改变。证据为 `artifacts/rich-layout/online-updates-2026-10-20-before.json` 与 `-after.json`；截图在 `artifacts/ui-updates/`。

用户提供 `FengZaiY/Project02_StudySelf`。已通过未登录浏览器读取该仓库页面的 Public 标记；命令行 GitHub API TLS 连接失败，未降低 TLS 校验，改用正常浏览器读取。当前本地 `git remote -v` 为空，不因此否认用户的远程仓库，也未擅自设置 remote。此次只固定发布来源，不提交、推送或上传。

## 未验证范围

未运行 `npm run dist` / `test:packaged`，未生成或安装新包。没有执行真实 GitHub Release 发布、正式安装包下载、NSIS 提权、签名验证、跨版本数据迁移或双机更新；本地模拟和源码桌面验证不等于这些验收已完成。当前 Windows 签名仍未配置，SHA512 不能独立证明发布者身份。正式分发由用户另行安排打包发布任务。
