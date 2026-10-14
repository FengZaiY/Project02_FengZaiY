# 资料预览与筛选布局验证

日期：2026-10-12。环境：Windows、Node.js 24.16.0、现有 Playwright 与开发 Electron。仅使用隔离生成的测试资料；原用户工作区只读核对与页面刷新。没有安装包构建、数据迁移、权限或同步协议修改。

## 本轮结果

| 命令 | 结果与覆盖 |
|---|---|
| `npm run build` | 通过，更新开发界面 |
| `npm run test:asset-previews` | 通过；实际图片/视频解码、视频像素非空、静止静音、文档格式封面、缺失文件不读取、坏图降级、点击预览、视频关闭清理、长列表按需加载及离开清理 |
| `npm run test:assets` | 通过，资料管理回归 |
| `npm run test:ui` | 通过，通用界面回归 |
| `node --test tests/rich.test.mjs` | 6 项通过，沿用的媒体权限与完整性路径 |
| `npm run test:desktop` | 沙箱首次因渲染进程限制失败；获准在沙箱外运行隔离桌面测试后通过，含 `studyself-media://asset/` 图片缩略图与既有桌面迁移回归 |
| `npm run check:project` / `git diff --check` | 通过，项目约定、脚本入口、文档链接与空白检查 |

新增长列表用例首次失败：夹具误将修改记录 ID 用于文件绑定，造成新增资料全部显示待下载；改为实体 ID 后复测通过，没有为通过测试修改应用行为。

## 布局与证据

检查了 1480、1220、1165、980、600 像素宽度。下拉框高度至少 38 像素，普通选项文字可完整放入；超长标签在下方换行。无整个页面横向溢出，窄窗口表格内部滚动，底部分页可达。截图已检查，600 像素用于窄窗口验证，不代表新增手机端。

- `artifacts/asset-previews/previews-1220.png`、`previews-1165.png`：资料缩略图与筛选布局。
- `artifacts/asset-previews/long-tag-600.png`：长标签完整显示。
- `artifacts/desktop/asset-thumbnails-native.png`：桌面真实协议缩略图。
- `artifacts/asset-previews/preview.png`：原 13895 用户预览更新后画面。

原预览继续使用既有启动锚点与原工作区，没有重启或替换为空测试库。`artifacts/asset-previews/verify-preview.mjs --after` 只读检查通过：11 个实体、136 条修改记录摘要和 7 个原件哈希与刷新前一致。本轮基线独立存放；上一轮资料管理的 134 条记录基线仍单独保留，不将跨轮次用户新增历史视为异常。

## 边界

- 图片支持 PNG/JPEG/WebP/GIF；视频使用浏览器可解码的 MP4/WebM/QuickTime 内容，容器格式不保证所有编码都可播放，失败显示“无法预览”。
- PDF/Office 文档是格式封面，不是真实首页缩略图。原 PDF 阅读器间歇空白未在本轮解决。
- 图片/视频来自原文件，未引入持久化缩略图缓存；大量超大图片的首次解码成本仍存在，按需加载与并发限制只降低同时读取压力。
- 完整 `npm test`、知识库/Agent 专项界面、真实双机与安装包测试本轮未运行，不借用此前结果作为本轮结论。
