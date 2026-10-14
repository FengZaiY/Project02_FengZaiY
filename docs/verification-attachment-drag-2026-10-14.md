# 原附件拖入正文验证

日期：2026-10-14。Windows，Node.js v24.16.0，Playwright Chromium，开发源码。所有交互写入测试均在 `artifacts/` 隔离工作区执行。

## 改动

- 原附件列表的可用文件支持原生鼠标拖拽到当前笔记正文，按落点插入图片、视频或内部附件链接。
- 拖动时显示绿色落点提示，编辑区边缘自动滚动；短按预览不变，Escape、失焦、拖动结束及离开笔记清理状态。
- 插入复用资料 ID，无上传、新资料记录或本机路径写入正文。沿用编辑事务、撤销和自动保存。
- 异步读取资料时映射落点；检查当前笔记、知识库归属、附件关联、删除和冲突状态。外部伪造自定义拖拽数据不触发内部插入。
- 没有改变核心存储、共享数据格式、桌面桥接或外部 Agent 权限。需求基线同步记录此操作。

## 本轮命令

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `npm run test:attachment-drag` | 最终通过，真实鼠标操作 |
| `npm run test:attachments` | 通过，既有关联管理、预览、编辑器保留、保存失败与并发 |
| `npm run test:ui` | 通过 |
| `npm run test:editor` | 通过，本地文件导入、长按布局、八方向缩放、自动保存与冲突 |
| `npm run test:document` | 通过，连续正文、选择、撤销和旧内容兼容 |
| `npm run test:rich` | 通过，图表、媒体、画板、保存重开和导出 |
| `npm run test:libraries` | 通过，知识库范围及原附件面板开关 |
| `npm run test:assets` | 通过，资料属性、引用、批量事务及回收恢复 |
| `npm run test:experience` | 通过，编辑工具、输入法、粘贴、引用及历史局部恢复 |
| `npm run test:agents` | 通过；更新需求基线后重跑通过 |
| `node --test tests/note-autosave.test.mjs` | 3 项通过 |
| `node --test tests/rich.test.mjs tests/editor-experience.test.mjs tests/asset-management.test.mjs` | 17 项通过 |
| `npm run check:project`、`git diff --check` | 通过 |

专项覆盖：文本链接的插入次序及原选中文字保留、真实图片和视频解码/播放、撤销重做、取消、伪造载荷、重复拖入不新增资料、资料版本和原件哈希保持、自动保存重开、等待校验时继续输入、失效/冲突/跨库/读取失败、切换笔记后迟到响应、空白笔记插入与撤销、编辑区边缘滚动后取消。

首轮新增空白笔记用例在切换界面尚未完成时抓取了旧附件按钮，发生 detached element。测试改为等待新笔记标题及附件列表后拖动，完整专项重跑通过；没有通过放宽生产逻辑绕过失败。测试的错误提示清理后再截图，避免使用上一条提示误判失败路径。

## 界面与原工作区

已检查 `artifacts/attachment-drag/drop-position.png` 及 `dragged-content-1220.png`、`dragged-content-931.png`、`dragged-content-600.png`。落点可见，图片/视频保持自适应，窄窗口工具栏换行，正文区域可滚动，无整页横向溢出。结构化报告在同目录 `report.json`。

更新预览前通过受信任只读接口核对启动锚点、本地存储根目录、AI人工智能知识库和无待保存标签；原页面也显示已保存。沿用原 13895 入口和原资料目录，仅刷新静态界面并回到 ChatGPT 笔记。页面确认 7 项原附件的 `draggable` 已启用，保存状态仍为已保存。没有在用户笔记执行拖入测试。

刷新前后只读 SQLite 对比 157 条不可变记录及全部当前分支，摘要相同；7 个原文件字节哈希与资料记录匹配。原工作区截图为 `artifacts/attachment-drag/original-workspace.png`。进程命令行查询被当前环境拒绝，入口核对使用服务返回的实际根目录和本机启动配置，不将该进程查询记为成功。

## 未验证范围

未运行本轮全量 `npm test` 和 `test:desktop`，本次没有核心或桌面桥接修改。未生成安装包，未测试百度双机、真实外部推理或 GB 级原件。媒体是否可播放仍取决于浏览器支持的编码；不可用或冲突附件不启用拖动。
