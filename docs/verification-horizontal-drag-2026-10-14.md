# 富内容横向排列验证

日期：2026-10-14。环境：Windows、Node 24.16.0、项目锁定的 Playwright/Chromium。写入测试使用隔离临时工作区。

## 原因和修改

原预览的导图与竖图是两个顶层富内容节点，没有横排容器。原逻辑只在鼠标进入素材内部左右四分之一区域时识别横排，旁边空白退回上下落点。旧样式还要求每项至少 180px，并在窄编辑区域强制变成纵列。

增加同父容器范围、同素材垂直高度内的左右空白识别，按最近横边确定落点；命中的元素须为素材祖先，避免抢占文字或相邻容器。竖向提示至少 36px 高。横排不自动换行，按原百分比尺寸分配并在必要时收缩；保留既有布局字段、原源数据、一次撤销和保存流程，不迁移或自动保存旧笔记。

## 本轮验证

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `node --test tests/block-layout.test.mjs tests/rich.test.mjs tests/note-autosave.test.mjs` | 18 项通过 |
| `npm run test:horizontal-drag` | 通过 |
| `npm run test:editor` | 通过 |
| `npm run test:rich-layout` | 通过 |
| `npm run test:line-drag` | 通过 |
| `npm run test:document` | 通过 |
| `npm run test:rich` | 通过 |
| `npm run test:ui` | 通过 |
| `npm run test:agents` | 通过，含偏好与 Skill 导出 |
| `npm run check:project` | 通过，56 项必需文件、70 份文档与 112 个本地链接 |

横排专项用真实鼠标验证小导图与竖图、原附件面板展开、素材外左右空白、竖向提示、引用内横排、两项较宽素材的收缩、横排内部换序与移出、尺寸调整、Escape 取消、一次撤销/重做、保存重开。检查原文本、布局和源数据保留。对 1220、931、600 窗口验证同一行、不重叠、比例不变和无页面横向溢出，包含实际宽度小于 360px 的横排。

已人工查看 `artifacts/horizontal-drag/right-drop-marker.png`、`horizontal-1220.png`、`horizontal-600.png`；量测见同目录 `report.json`。小图仍按用户尺寸展示，极窄窗口可能需要放大素材或收起附件面板才能清晰阅读图内文字。

## 原资料和边界

原 13895 预览沿用 `.local/preview-0.1.1`，刷新前确认原 ChatGPT 笔记已保存、无弹窗和未保存标签。刷新前后 169 条修改记录、16 个实体、当前分支与 7 个原文件哈希完全一致。证据为 `artifacts/rich-layout/horizontal-drag-before.json` 和 `horizontal-drag-after.json`。没有在用户笔记上执行拖动或保存测试。

本轮未运行全量核心、桌面或安装包验证，未生成安装包。未专门验证一行放置大量素材的极端布局；普通正文不改成多栏编辑。
