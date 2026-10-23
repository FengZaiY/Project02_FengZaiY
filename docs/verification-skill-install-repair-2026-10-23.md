# Skill 安装文件缺失修复验证

日期：2026-10-23。环境：Windows，源码版本 0.1.8 后续工作区改动；不更新既有发布产物。

## 现场核对

仅只读检查用户指定的 WorkBuddy Skill 目录：目录及 `.studyself-install.json` 存在，固定包文件 `SKILL.md`、`references/preferences.md`、`references/api.md`、`scripts/client.mjs`、`manifest.json` 均不存在，references/scripts 为空，宿主 `_user_meta.json` 保留。没有证据确定缺失由谁或哪个程序导致。没有扫描其他安装位置，没有写入真实安装或正式知识库。

## 自动验证

- `node --test tests/skill-installations.test.mjs`：11 项通过，包括原更新/恢复用例，以及所有固定文件缺失、自动模式不补全、用户确认/取消、身份与归属变化、过期预览、写失败回滚、恢复不完整副本和额外文件保留。
- `npm run build`：通过，仅构建开发界面。
- `npm run test:skills`：通过，隔离安装验证缺失提示、缺失项及覆盖项分别预览、取消不写入、确认补全后内容等于当前导出；原偏好、更新、恢复、自动检查和窄窗口回归通过。
- 已人工查看 `artifacts/ui-skill-manager/repair-confirm.png`、`installs-1001.png`：操作名、缺失与覆盖清单清晰，按钮和状态栏可达，无文字重叠。
- `npm test`：287 项通过，0 失败。
- `npm run test:ui`：通过，通用编辑、标签、同步、部分确认及并发编辑回归。
- `npm run check:project`：通过，99 个必需文件、132 份文档、199 条本地链接及脚本/锁文件契约。
- `git diff --check`：通过。

## 边界

本轮未打包、未提交、未推送，未改用户外部 Skill 安装；未运行源码桌面专项，未验证已安装桌面程序升级。新修复仍需发布任务纳入安装包后才能出现在已安装程序中。既有程序可通过导出完整 Skill 并将包内固定文件补到原安装目录恢复；需保留关联标记、宿主元数据和其他文件。
