# 笔记导航视图验证

日期：2026-10-12。环境：Windows、Node.js 24.16.0、本机 Playwright 和开发 Electron。测试使用 `artifacts/` 下独立临时工作区，不向正式资料写入测试笔记。

## 范围

- 知识体系与笔记列表不再同时展示；共用知识库标题、计数、新建、范围及搜索。
- 默认树形，本机保存视图选择；不同知识库独立分组，范围选择在两种视图中生效。
- 搜索保留命中项祖先，空结果明确显示；搜索结束恢复原收起状态。
- 切换不重建正文编辑器，未保存内容、撤销和重做仍有效；刷新保留视图选择。
- 长树最后一项可滚动到状态栏上方；检查 1480、1165、600 像素宽度，两种视图截图无页面横向溢出。600 像素仅代表窄窗口。

## 本轮结果

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过；最后补充导航滚动保持后重新构建 |
| `npm run test:ui` | 通过；最终构建后复测 |
| `npm run test:libraries` | 通过；最终构建后复测，新增树/列表范围隔离 |
| `npm run test:hierarchy` | 通过；覆盖互斥视图、持久化、编辑器身份、撤销重做、搜索及底部可达 |
| `node --test tests/note-hierarchy.test.mjs tests/hierarchy.test.mjs` | 17 项通过 |
| `npm run test:editor` | 通过；首次并行运行在短按手势计时断言失败，单独重跑通过，未修改手势实现或放宽断言 |
| `npm run test:desktop` | 通过；沙箱内启动失败，沙箱外隔离测试通过；未生成安装包 |
| `npm run check:project` / `git diff --check` | 通过；43 个必需文件、46 篇文档、82 个本地链接，无补丁空白错误 |

首次新层级界面测试在刷新尚未完成时滚动到已替换节点，补充等待实际 49 项树节点后重跑通过。以上不是百度双机或安装包验收；未运行全量 `npm test`、Agent/富内容专项。本轮未修改核心业务或外部 Agent 协议。编辑器和桌面专项执行于最后只增加导航滚动位置保持之前；最终构建后复测通用、知识库和层级界面。

截图位于 `artifacts/ui-note-hierarchy/`：`knowledge-1165.png`、`knowledge-tree-600.png`、`note-list-1165.png`、`note-list-600.png`、`tree-scroll-bottom.png`。

## 原预览

通过原 `http://127.0.0.1:13895/` 的只读状态核实实际工作区为 `.local/preview-0.1.1`，仍包含“AI人工智能”、1 篇正式笔记及 4 项附件。确认无未保存标签后刷新页面，保留当前 ChatGPT 标签、正文及图片视频；截图为 `artifacts/note-views-preview.png`。未重启服务、切换根目录、迁移资料或创建样例内容。
