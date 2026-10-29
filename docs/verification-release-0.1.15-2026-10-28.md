# FengZaiY 0.1.15 发布验证

日期：2026-10-28。用户授权核对、合并提交、推送、构建、标签及Release草稿；未经本轮明确确认不得公开。

## 固定来源

- 基线：0.1.14，main/远端均为7a066708098b502bbdb6e41c8e551cdc6ab5acb5。
- 29个文件合并提交本轮存储维护界面、废弃空目录历史判断及桌面窗口激活修复与版本更新。旧版本交付文档及其他无关修改保留并排除。
- 提交：77d4bc3a5c21a4c7c6d9e44ea511c5db2f14e65b，已推送main。
- 注解标签v0.1.15：标签对象d5ccbfacd3870da7f40ff35bdb2d381b0559384d，远端解引用与固定提交一致，核对时远端main亦相同。
- 源码经git archive展开至artifacts/release-0.1.15-fixed。复用上次实际依赖缓存，将缓存移入本次隔离副本，旧副本仅恢复依赖链接；不从链接依赖目录打包。最终本轮构建使用Electron 42.11.12及锁定依赖，npm run dist明确--publish never。

## 本轮验证

以下副本日志均位于artifacts/release-0.1.15-fixed/artifacts。

| 验证 | 结果 |
|---|---|
| 完整核心 | node --test --test-concurrency=2 tests/*.test.mjs，388项中387通过，1失败，0跳过/取消；core.log，约513秒 |
| 核心复跑 | 唯一失败为退役Git备份兼容测试的bundle.lock超过Windows路径限制。确认原工作区src/web/tests/scripts/skills及版本文件与固定提交无差异后，在较短原路径原样复跑该项通过；仓库artifacts/release-0.1.15-legacy-shortpath.log。未改全局Git配置或退役实现 |
| 浏览器 | 15脚本中13直接通过；release-0.1.15-tests/browser-results.json。包含存储维护/迁移、回收、接收、资料、个人业务、可读目录、通用、启动、Agent、Skill、更新、知识库、目录浏览与本机审核 |
| 通用界面适配 | 原test-ui等待已移除的退役状态文案超时。适配为直接断言旧conversation记录已清理及清理状态完成，再检查当前存储扫描控件和窄窗；ui-adapted.log通过，不取消数据清理断言 |
| Agent界面适配 | 新增高级维护details使原宽泛summary选择器匹配两项。仅精确定位“需求基线”，授权、撤销、偏好、导出及底部可达断言保持；agents-adapted.log通过 |
| 源码桌面 | test-desktop、test-exit-ui、test-audit-fixes-desktop三项通过，记录于release-0.1.15-tests/desktop-results.json |
| 实际窗口激活 | window-source.log及window-packaged.log通过。触发真实second-instance处理器，分别隐藏/最小化隔离窗口，检查visible=true、minimized=false、版本0.1.15和隔离工作区身份；初次加载激活路径不以smoke模式测试冒充 |
| 包后通用 | 实际FengZaiY.exe启动、安全IPC、SQLite、MCP、原生媒体、目录选择、迁移、原件保留及加密凭据通过；packaged.log |
| 包后个人管理 | 按当前“导出”目录适配旧路径断言。最初两次在31秒等待期间被外部剪贴板改写，原空值断言失败；personal-packaged.log、personal-packaged-retry.log保留错误位置，非测试剪贴板内容脱敏。后续适配只清理/恢复测试自有内容，明确区分外部改写和计时结果。最后单独运行记录“unchanged native clipboard expired”，导出、复制、新值保护、模拟锁屏、密码库及保存后退出实际落盘全部通过；personal-packaged-external-aware.log |
| 视觉检查 | 已查看storage-maintenance-ui/settings-600.png、trash-ui/directories-600.png及window-activation/packaged.png，根目录、完整路径、分组和控件可见，无明显重叠；自动测试覆盖1304/850/600等宽度 |
| 项目与差异 | npm run check:project、git diff --check通过；不是CI或lint |

源码桌面共4项（含实际窗口专项），包后共3项。首轮失败和适配未隐去，不把全量首轮写成全通过。未修改业务源码以迎合断言，未降低沙箱、来源验证、密码参数或完整性保护。

## 附件来源与完整性

仓库artifacts/release-0.1.15-integrity.json记录190个构建输入、71个包内源码/Skill文件及418个提交文件源码快照校验。仅src/preview/directory-picker.ps1记录CRLF/LF规范化。包内dist与构建一致，包元数据及固定GitHub更新源正确；latest.yml文件大小/SHA512、blockmap解析通过，源码快照另附BUILD-PROVENANCE.json。

最终产物位于release/0.1.15；生成源码快照和SHA256清单后未再重建。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.15-Setup.exe | 112229327 | e630a59f56a1d596b863dec6b423085de42cd927c3a953fc6893296d4d1878ad |
| FengZaiY-0.1.15-Setup.exe.blockmap | 119402 | a5dd2eac18ba5671221ed8039e45ecfbb739e326f23f5391c386a94583e27c03 |
| latest.yml | 348 | 0adb6e131edf9451d2e77cd6e2b5bd3c20808a3caa813e03593fdd412efbdbfa |
| FengZaiY-0.1.15-source.zip | 1253390 | 1a1071b676216d8a8e2aaf1f9c21fa6c5e130b9b0572e01e3c2f656368d8c876 |

第五附件SHA256SUMS.txt包含上述四文件摘要。Get-AuthenticodeSignature确认安装包及主程序均NotSigned，构建日志中signtool字样不作为已签名依据。

## GitHub草稿与边界

草稿地址：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-8cf23c82cf744f68bacb

使用--draft --verify-tag --target固定完整提交号创建。上传后重新读取确认isDraft=true、tagName=v0.1.15、targetCommitish准确，正文匹配本地发布说明，五附件均uploaded，远端大小与SHA256逐项一致。证据artifacts/release-0.1.15-github.json及verify-release-0.1.15-github.ps1。没有公开Release；上一版“允许”不视为本版公开授权。

真实安装向导、卸载、跨版本升级及百度双机传输未验证。包后隔离运行、模拟锁屏和目录迁移不代替这些验证。初次非smoke启动的显式激活路径本轮未单独运行，真实second-instance窗口恢复已验证。未操作正式工作区、实际整理方案、真实清理或外部客户端配置。

后续交付记录留在工作区，不追改固定提交、标签及源码快照。format 9与内部布局兼容边界保持0.1.14约定。
