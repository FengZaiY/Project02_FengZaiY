# 思维导图交互验证

日期：2026-10-14。Windows，Node.js 24.16.0，现有 Mermaid 12 与新增直接依赖 D3 hierarchy 3.1.2。

## 参考与范围

阅读 Xmind 官方 User Guide / Xmind Basics / Topic（`https://xmind.com/user-guide/topic-editing-new`，本次通过浏览器读取）。采用主题直接编辑、Tab 子主题、Enter 同级主题、拖动换层级、Alt＋上下排序、分支配色和撤销的操作习惯，不复制品牌界面或宣称完整功能兼容。

导图保存仍是现有 diagram 源文本；仅新增可兼容 Mermaid 的布局注释，不改数据库、Agent 权限或同步协议。使用 Mermaid 官方解析结果和 D3 布局，原始主题声明保留。特殊语法回退源文本编辑及原渲染，不丢弃高级信息。

## 通过的检查

| 命令 | 结果 |
|---|---|
| `node --test tests/mindmap.test.mjs tests/rich.test.mjs tests/note-autosave.test.mjs` | 13 项通过：原始声明/注释保留、结构和层级边界、移动循环保护、布局尺寸、富内容引用/权限/历史/同步、自动保存与并发保护 |
| `node --test tests/agents.test.mjs` | 15 项通过：授权、跨范围/敏感引用、幂等、偏好版本、局部确认及 Skill 导出 |
| `npm run build` | 通过 |
| `npm run test:mindmap` | 通过：双击正文导图与主题、增删、Tab/Enter/F2、中文组合输入、特殊字符/emoji/换行保存重开、拖动改上级、右键菜单、折叠、布局/配色、缩放、撤销/重做、源文本往返保留撤销、错误源文本拒绝、取消确认、Markdown 导出 |
| `npm run test:rich` | 通过：全部图表模板、公式、媒体、画板、保存重开、撤销及导出 |
| `npm run test:ui` | 通过：通用编辑、标签/范围、同步、局部确认和过期编辑 |
| `npm run test:agents` | 通过：授权界面、方案、偏好、Skill 导出及撤销 |
| `npm run test:desktop` | 隔离的开发桌面验证通过，包含安全 IPC、编辑器、媒体及本机存储迁移；未打包 |
| `npm run check:project` / `git diff --check` | 通过 |
| `python -X utf8 .../skill-creator/scripts/quick_validate.py skills/studyself-organize` | 通过 |

最终源文本撤销连续性、选择节点可见性与正文双击入口调整后，重跑构建和导图专项通过；补充节点数量、最大层级及移动失败完整性断言后，模型测试再次 5 项通过，本轮定向核心测试共 29 个不同用例通过。检查 `artifacts/mindmap-ui/canvas-1220.png`、`edited-1220.png`、`edited-980.png`、`edited-600.png`。确认连线实际占据画布、无页面横向溢出、画布高度大于 300 像素，保存按钮位于可见窗口内。

初次测试发现鼠标捕获抢走双击、全局图标尺寸令连线缩成 17 像素，以及 Mermaid 解析结果的实体占位符未解码。分别改为移动超过阈值才捕获、显式布局尺寸、实体占位符文本解码，并增加回归断言；修复后专项通过。没有沿用失败结果作为通过证据。

## 原预览

原 13895 页面沿用原启动锚点与实际工作区，只更新界面构建并刷新，不重启空库。刷新前确认无未保存笔记及编辑弹窗，后台无同步或目录整理任务。刷新后回到原笔记，打开新建思维导图窗口展示但未点击保存。

前后 16 个实体、160 条原始修改记录、当前分支及 7 个原文件哈希一致。校验记录为 `artifacts/mindmap-ui/preview-before.json` / `preview-after.json`；实际预览截图为 `artifacts/mindmap-ui/preview.png`。所有写入测试只用隔离资料。

## 尚未验证或实现

未运行全量核心测试、正文编辑体验/附件拖动专项、真实双机部署联调或安装包验证。没有新增安装包。高级源文本可保留并渲染，但不保证均能转为可视化编辑；仅支持树形主题，不包含 `.xmind` 互通、自由主题、跨主题关系线或概要括号。500 个主题/40 层是输入保护边界，不是性能承诺；极长或更复杂源文本继续保留原入口。缩放和平移不跨设备保存。
