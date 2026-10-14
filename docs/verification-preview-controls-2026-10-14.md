# 原附件预览控件与布局验证

日期：2026-10-14。环境：Windows、Node 24.16.0、Playwright Chromium，隔离临时工作区。

## 改动

- 替换仅滚回顶部的“返回附件列表”为“关闭预览”，保留放大按钮；关闭返回列表并恢复附件按钮焦点，不解除关联。
- 独立中止原附件预览，清除媒体源、临时 URL 和阅读页；异步文件结果不能重新打开已关闭的预览。
- 文件名称/状态与“附件操作”菜单同行，行高约 49px；菜单集中详情、编辑属性、解除关联，支持 Escape/点击外部关闭。完整名称及状态保留悬停提示，拖入正文绑定不再覆盖该提示。
- 不改核心存储、附件身份、同步格式或外部 Agent 权限。

## 本轮验证

- `npm run build`：通过。
- `npm run test:attachments`：通过；关闭/重开保留编辑器、新输入及撤销，覆盖关联、失败/冲突、原件保留，1480/1304/1001/931/600 宽度行高及溢出检查；180px 面板文件名宽度与菜单边界、Escape/点击外部关闭通过。
- `npm run test:docx-preview`：通过；关闭 Word 阅读页、延迟读取后关闭、重开、Worker 释放、放大及切换笔记保护。
- `npm run test:attachment-drag`：通过；真实视频播放后关闭，验证暂停、移除媒体源及脱离页面；图片关闭/重开，原拖入、撤销、身份与切换保护回归。
- `npm run test:ui`、`npm run test:libraries`、`npm run test:assets`、`npm run test:agents`、`npm run check:project`：通过。
- 已查看 `artifacts/ui-note-attachments/attachments-1304.png`、`attachments-600.png`、`attachments-narrow-menu.png` 和 `artifacts/docx-preview/side-1001.png`；最终菜单在 180px 窄面板可完整显示，文件名空间不被多个常驻图标挤占。

## 原预览复核

沿用端口 13895 和原启动锚点 `.local/preview-0.1.1`，确认已保存、无弹窗和未保存标签后刷新。实际图片预览有关闭按钮，关闭后预览区域消失、滚动回顶部，六项附件仍在，笔记保持已保存。最终紧凑菜单截图为 `artifacts/ui-note-attachments/original-preview-controls.png`。

只读核对前后 174 条修改记录、16 个实体、全部当前分支、7 个原文件哈希一致，SQLite 完整性检查通过。证据为 `artifacts/rich-layout/preview-controls-before.json` 与 `preview-controls-after.json`。未修改用户正文或附件。

## 范围

本轮未运行核心全量、桌面、安装包、真实双机或性能测试；未生成安装包。预览仅本机读取，不使用真实模型或云端账号。
