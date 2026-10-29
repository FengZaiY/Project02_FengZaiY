# FengZaiY 0.1.14 发布验证

日期：2026-10-28。用户授权提交、推送、构建和创建草稿，禁止未经明确确认公开。

## 来源与范围

- 固定源码：7a066708098b502bbdb6e41c8e551cdc6ab5acb5，main 已推送到 FengZaiY/Project02_StudySelf。
- 注解标签 v0.1.14 的标签对象为 ffa6bf8603b62b232e52d4f6dffd960a4db7e520，远端解引用为上述固定源码，核对时远端 main 相同。
- 97 个文件合并提交本轮功能、版本、文档及测试，旧版本交付文档保留并排除。
- 构建期间发现另一任务新增窗口激活修改；首份原工作区构建不再使用。固定提交经 git archive 展开至 artifacts/release-0.1.14-fixed，最终从该隔离副本构建。另一任务后续的废弃目录历史修复也未纳入本版。
- 隔离副本最初使用依赖目录 junction，打包器漏收传递依赖，该候选亦弃用。仅移除确认过的 junction，复制实际锁定依赖后重新构建；最终日志为该副本 artifacts/build-final.log。没有覆盖或回退另一任务源码。

## 验证结果

| 项目 | 本次结果与证据 |
|---|---|
| 完整核心 | node --test --test-concurrency=2 tests/*.test.mjs，384 项中383通过，1失败；artifacts/release-0.1.14-core.log |
| 核心失败复跑 | naming-format 的历史 git show 被仓库属主检查阻止；仅在进程内设置当前仓库 safe.directory，该文件2项原样通过；artifacts/release-0.1.14-naming-retry.log。未改全局配置 |
| 浏览器回归 | 26脚本首轮22通过、4失败；artifacts/release-0.1.14-tests/browser-results.json。覆盖通用/启动/可读资料/MCP/编辑/更新/授权/Skill/目录/层级/草稿/回收/存储/同步/富内容等 |
| 浏览器复跑 | 资料筛选即时计数、长按拖动、历史渲染3脚本在固定副本原样复跑通过；副本 artifacts/release-0.1.14-fixed-tests/browser-retry-results.json。保留首次失败，不据复跑判断确切根因 |
| 接收目录适配 | 原脚本向旧 received-objects 写入测试文件，等待新目录状态超时；仅改为 workspaceInternalPath，新路径下分页、续传、保护及空目录清理通过；副本 artifacts/received-adapted.log |
| 设备导航适配 | 先进入“多电脑同步”再打开设备页面，既有业务断言保持；副本 artifacts/devices-adapted.log 通过 |
| 固定副本源码桌面 | 通用、退出、审计修复、MCP、本机下载5脚本通过；副本 artifacts/release-0.1.14-fixed-tests/desktop-results.json |
| 个人桌面与剪贴板 | 导出、密码锁定、退出保存、快捷键和代码粘贴3脚本通过；副本 artifacts/personal-adapted.log、shortcuts-desktop.log、code-paste-desktop.log。原个人脚本仍断言旧 exports 路径，适配为当前“导出”，失败日志保留在首轮测试目录 |
| 包后验证 | 副本 artifacts/packaged.log、personal-packaged.log 两脚本通过，使用实际 FengZaiY.exe 和隔离 profile，保留安全沙箱与鉴权 |
| 视觉 | 已查看可读资料600宽、审核弹窗600宽、代码块600宽及包后主窗口截图；文字/控件可达，无明显重叠 |
| 项目与差异 | npm run check:project 与 git diff --check 通过；不是 lint 或仓库级CI |

源码测试先在原工作区运行，检测并发修改后源码桌面和相关复跑改用固定副本。最终包内容逐文件校验固定提交，不将原工作区后续修改冒充已发布功能。未为通过测试降低密码参数、来源校验、持久化或完整性要求。

## 附件完整性

artifacts/release-0.1.14-integrity.json 记录186个构建输入、70个包内源码/Skill文件与固定提交校验；仅 src/preview/directory-picker.ps1 记录了 CRLF/LF 规范化。源码快照核对408个提交文件，另含 BUILD-PROVENANCE.json；dist 与包内界面相同，固定更新源正确，latest.yml 大小/SHA512及blockmap解析通过。

最终附件位于 release/0.1.14。源码快照与校验清单生成后未再重建或重新生成：

| 文件 | 字节 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.14-Setup.exe | 112224387 | adb496ac3eb70617aa95006250802f532311eefd7e4060a60b6956dcddea9e94 |
| FengZaiY-0.1.14-Setup.exe.blockmap | 119172 | 0d63f39cae7d66ed997e656c59bffdc94e7c66c5d80e340a1a861a6e2c178915 |
| latest.yml | 348 | b6e6c9e44b4291daedd92b009ae77f72b4642731bfb3b0ac967ad825938784b6 |
| FengZaiY-0.1.14-source.zip | 1236647 | ae208cd981f79cc1d119817bde9cea685ac5aa1f73f3f970f911e88a88b629b9 |

第五附件为 SHA256SUMS.txt。Get-AuthenticodeSignature 确认安装包及主程序均为 NotSigned，构建日志中 signtool 字样不代表实际签名成功。

## GitHub 草稿与边界

草稿地址：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-25deed024e9829c87f38

创建使用 --draft --verify-tag --target 固定完整提交号。上传后重新读取：isDraft=true、tagName=v0.1.14、targetCommitish 为固定提交，正文匹配本地发布说明，五附件均 uploaded 且大小/SHA256逐项一致。证据 artifacts/release-0.1.14-github.json 与 verify-release-0.1.14-github.ps1。没有公开 Release。

真实安装向导、卸载、跨版本升级及百度双机传输未验证；包后启动、模拟锁屏、隔离迁移和本机下载不替代这些验证。未操作正式资料、待确认整理方案、真实旧副本、外部 Skill 配置或已安装程序。format 9 需要所有同步电脑升级，内部布局迁移后旧版不能打开。过期上传暂存清理、分类删除/恢复专门界面和旧导出迁移仍为已有未完成项。

交付文档保留工作区，不追改固定提交、源码快照或标签；其他任务及旧交付文件修改继续保留。

## 用户确认后正式公开

用户收到草稿交付后明确回复“允许”。公开前再次核对草稿、正文、五附件大小/SHA256及远端注解标签目标，全部一致。随后执行 gh release edit v0.1.14 --draft=false --latest，更新发布说明末尾为用户已确认发布，未重建或替换附件。

GitHub publishedAt 为2026-10-28T08:45:22Z，即北京时间2026-10-28 16:45:22。公开地址：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/v0.1.14 。重新读取确认 isDraft=false、isPrerelease=false，latest接口返回v0.1.14，固定提交、正文及五附件大小/SHA256全部匹配。证据保存于 artifacts/release-0.1.14-published.json；前文草稿状态属于发布前历史记录。
