# 正文插入内容尺寸验证

日期：2026-10-14。环境：Windows、Node 24.16.0、项目锁定的 Chromium/Playwright 与 Electron 开发源码。

## 实现与范围

- 复用既有 `data-ss-layout`；SVG 的 viewBox 和画板预览图片参与比例计算，异步绘制完成后应用尺寸。
- 去掉思维导图独立最小高度约束，图形与调节点实际边界一致；选中或操作时才出现调节点，不加固定外框。
- 长按编排、取消、文档撤销和导图双击编辑继续使用现有交互。源文本、画板对象及同步协议不变。
- 公式、贴纸继续沿用其既有内容布局；普通正文、表格、附件链接不增加缩放容器。

## 本轮验证

全部测试使用隔离目录，不写正式笔记。

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `node --test tests/rich.test.mjs tests/mindmap.test.mjs tests/note-autosave.test.mjs` | 14 项通过 |
| `npm run test:rich-layout` | 通过，检查可见内容的实际宽高及比例，不仅检查布局属性 |
| `npm run test:editor` | 通过，原图片/视频八方向调节、播放控件、编排、保存失败与冲突保护 |
| `npm run test:document` | 通过，连续正文与旧框兼容 |
| `npm run test:rich` | 通过，全部图表模板、媒体播放、画板、保存/导出 |
| `npm run test:mindmap` | 通过，可视化导图编辑与双击入口 |
| `npm run test:ui` | 通过 |
| `npm run test:agents` | 通过，含偏好和 Skill 导出 |
| `npm run test:desktop` | 正常桌面环境通过；受限环境首次启动 GPU 子进程失败，未修改安全开关，重试成功 |

尺寸专项覆盖思维导图八方向鼠标缩放、键盘调整、Escape 取消、一次编辑撤销/重做、流程图与画板比例、长按取消和横排、双击取消、保存重开、历史阅读及源数据不变。人工查看 `artifacts/rich-layout/layout-1220.png`、`layout-600.png`；自动检查另含 931 宽度。所有宽度无页面横向溢出；普通段落没有调节点。很小的导图会等比例缩小文字，双击可在独立画布阅读/编辑。

## 原预览

核对端口 13895 仍使用原启动工作区，原知识库存在；页面已保存、无打开的对话框、无未保存标签后刷新。恢复原 ChatGPT 标签显示，读取确认导图实际尺寸为 760 × 176.8125px，与整块边界相同，八个调节点已存在。未对正式笔记执行缩放、拖动或保存。

本轮刷新前后只读校验：163 条修改记录、16 个实体、当前分支摘要和 7 个原文件哈希一致；SQLite 完整性检查通过。证据在 `artifacts/rich-layout/preview-before.json` / `preview-after.json`。

未运行全量核心与安装包验证，未生成安装包。没有将前次任务测试当成本轮结果。

## 后续调整：长按统一为 0.5 秒

2026-10-14 按用户要求将共用手势入口的等待时间由 1000ms 改为 500ms，覆盖图片、视频、思维导图、其他图表、画板、公式及贴纸。短按移动取消、播放控件排除、取消/撤销保持不变。同步更新当前约定、架构和 Skill 偏好；旧验收记录的一秒描述保留为历史事实。

本次重新通过 `npm run build`、`npm run test:editor`、`npm run test:rich-layout`、`npm run test:ui`、`npm run test:agents`；查看本次 `artifacts/editor-interactions/long-press-drag.png`。原 13895 预览已刷新，刷新前后 165 条修改记录、当前分支与 7 个原文件哈希一致（`artifacts/rich-layout/half-second-before.json` / `half-second-after.json`）。本次未运行核心全量与桌面测试，未生成安装包。
