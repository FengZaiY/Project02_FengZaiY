# StudySelf 0.1.2 发布验证

日期：2026-10-20。环境：Windows 10 19045、Node 24.16.0、Electron 42.11.12、electron-builder 26.15.3。起点为干净工作树，提交 `1cea2093f83a4c6daf045d00a73a7063995c52ae`。

## 源码范围

本轮更新 package.json、锁文件根版本及 Service 状态版本为 0.1.2，不改数据协议或依赖。存储界面旧测试定位同时匹配新增的多个按钮，已将其收窄为提交按钮，保留原有底部可达断言。

初次准备未提交或推送源码，未修改 Git remote，未操作正式资料、原预览和百度客户端。测试使用 artifacts 下的隔离工作区。后续源码提交与目标状态见文末标签核对。

## 已完成验证

- `npm test`：207 项通过，失败/取消/跳过均为 0；日志 `artifacts/release-0.1.2-core.log`。
- `npm run build`、`npm run check:project`：通过。
- `npm run test:ui`、`npm run test:updates`：通过；已查看窄窗口、桌面和更新页截图。
- `npm run test:desktop`：通过，包含原生加密、SQLite、IPC、附件媒体、Word 预览、目录选择及重启迁移。
- `npm run dist`：通过，以 `--publish never` 构建 Windows x64 NSIS。
- `npm run test:packaged`：通过，实际包内应用启动和重启迁移验证；报告位于 `artifacts/desktop/packaged-report.json` 和 `storage-report.json`。
- 安装包和主程序 Authenticode 均为 `NotSigned`。构建日志中的 signing 字样不代表已签名。
- 自检脚本 `artifacts/verify-release-0.1.2.mjs`：核对 latest.yml SHA512/大小/文件名、blockmap 可解析、包内版本和核心源码字节、固定 GitHub 更新源，生成源码快照及 SHA256SUMS。

## 专项回归

以下 23 项专项命令全部通过，各专项日志保存为 `artifacts/release-0.1.2-test-*.log`：

`test:libraries`、`test:assets`、`test:agents`、`test:skills`、`test:drafts`、`test:trash`、`test:hierarchy`、`test:note-drag`、`test:storage`、`test:experience`、`test:rich`、`test:mindmap`、`test:attachments`、`test:docx-preview`、`test:attachment-drag`、`test:dedup`、`test:asset-previews`、`test:asset-storage`、`test:rich-layout`、`test:line-drag`、`test:horizontal-drag`、`test:editor`、`test:document`。

已查看本轮桌面原生正文、通用窄窗口、更新窄窗口及草稿发布状态截图。更新专项截图使用模拟版本/来源，不代表真实发布安装。

## 异常及重试

- 首次沙箱内源码桌面测试 GPU 子进程退出，页面 ERR_FAILED。使用隔离工作区在沙箱外重跑通过，未关闭应用安全设置。
- 首次存储界面测试因按钮定位匹配多个元素失败。仅修正测试选择器后重跑通过，未修改业务行为。
- GitHub CLI 现有凭证失效，匿名 API 又遇到限流；使用已登录浏览器准备 Release 草稿，不读取或导出凭证。

## 发布产物

- 安装包 `release/StudySelf-0.1.2-Setup.exe`：109,729,261 字节，约 104.65 MiB。
- 安装包 SHA256：`139ea4ac3a476731a2e1bd13eb86b59d85f358cf1e3220b704c462e709fb9b47`。
- 配套 `.blockmap`、`latest.yml`、源码快照和 `SHA256SUMS.txt` 同在 release 目录。
- 完整哈希记录见 `artifacts/release-0.1.2-integrity.json`。

## 未验证与公开前要求

未运行真实安装向导、卸载、跨版本 NSIS 安装、真实双机升级或正式 GitHub 更新下载。未签名；沿用默认 Electron 应用图标。既有 PDF 预览间歇空白问题未在本轮修复。

GitHub 草稿已保存并在 Releases 列表核对 `Draft` 标记，尚未公开：

`https://github.com/FengZaiY/Project02_StudySelf/releases/edit/untagged-ec80f97a7fd5ee176725`

初次截图：`artifacts/release-0.1.2-github-draft.jpg`。首次附件上传因浏览器扩展缺少“允许访问文件网址”权限被拒绝；CLI 凭证亦已失效。用户开启权限后，通过已登录浏览器补传五个附件并保存草稿，未公开。

补传前重新逐项计算并核对 SHA256SUMS 中的四个文件，全部匹配；安装包 109,729,261 字节、blockmap 117,079 字节、latest.yml 347 字节、源码快照 728,254 字节。未重新构建或改写发布附件，保持与上一轮测试产物一致。源码快照包含打包时源码及当时文档；后续上传状态文档维护不改变应用源码或安装包。草稿说明已移除权限阻塞旧文案，保留源码提交与标签待核对提示。

补传证据截图：`artifacts/release-0.1.2-github-assets.jpg`。本次仅上传和维护状态文档，没有重跑应用测试；项目检查和差异空白检查另行执行。

公开前由用户核对。未执行性能基准；本轮没有改变查询或批量数据算法。

## 后续标签目标核对

2026-10-20 按用户要求只核对并修正说明，不执行公开发布。工作树开始时干净，本地已存在提交 `d2f7460866bf1d57c71054280ac95deff3c1f24a`（chore: prepare StudySelf 0.1.2 release candidate），包含版本、测试与发布文档修改。

`git ls-remote` 确认 GitHub main 同为该提交，远端没有标签。首次沙箱内查询出现 schannel 凭据环境错误，沙箱外只读重试成功。草稿显示 v0.1.2、Target: main，提示发布时才创建标签；仍为未公开草稿。当前实际编辑地址为 `https://github.com/FengZaiY/Project02_StudySelf/releases/edit/untagged-f11ee2d022961e6a4ae9`，同一 Release ID 418023468。

逐字节核对包内全部 37 个核心、桌面与 Skill 源文件与当前工作树一致；工作树开始时干净，因此亦与该提交一致。包内及提交版本均为 0.1.2；SHA256SUMS 中四个发布文件逐项匹配。未重建或替换附件。源码快照在提交前冻结，来源说明保留当时状态；后续文档记录不改变已冻结的应用源码。

草稿旧“尚未提交推送”说明已修正为上述实测目标，未修改发布目标、创建标签或公开。main 是分支，后续若有新提交，公开前须重新核对。证据截图：`artifacts/release-0.1.2-tag-target.jpg`。本次没有修改业务代码或重跑应用测试，仅执行项目检查和差异空白检查。
