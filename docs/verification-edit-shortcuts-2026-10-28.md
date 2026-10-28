# 笔记编辑快捷键验证

日期：2026-10-28。仅改动编辑区快捷键处理和说明，保留工作区其他在途修改；没有更改数据库、MCP、同步格式或桌面权限。

## 实现与结论

修改前在隔离 Electron 中实测普通正文及标题的 Ctrl+A/C/V/Z 已可工作，不能将菜单为空直接判定为失效原因。本轮增加正文范围内的明确键盘处理：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做，Ctrl+A 全选正文；即使编辑历史为空也阻止落入浏览器独立 DOM 撤销栈。输入法组合、Alt 组合及正文内嵌输入控件不抢占，标题/搜索等区域继续使用自己的操作。

复制、剪切、粘贴保留原生剪贴板及已有清理/导入流程，不降为纯文本，不新增剪贴板权限。编辑区增加可展开的“快捷键”说明，撤销/重做按钮提示按键；说明支持 Escape 收起，不写入笔记正文。

## 本轮验证

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `node scripts/test-edit-shortcuts.mjs` | 通过：空历史、全选、原生复制、保留加粗格式的粘贴、剪切、撤销、两种重做、标题焦点、正文及草稿代码块、保存后持久化 |
| `node scripts/test-edit-shortcuts.mjs --desktop` | 在正常本机进程环境通过相同操作链；隔离 Electron profile，保存并有条件恢复剪贴板 |
| `node scripts/test-editor-experience.mjs` | 通过：输入法、选择、快捷插入、表格粘贴、引用、历史取回和响应式截图 |
| `node scripts/test-code-blocks-ui.mjs` | 通过：空格/制表符、缩进撤销、代码复制、保存重开及 1220/931/600 窗口 |
| `node scripts/test-desktop.mjs` | 通过：源码桌面、IPC、编辑器、媒体、原生目录选择及隔离存储重启 |
| `npm run check:project`、`git diff --check` | 通过 |

证据在 `artifacts/edit-shortcuts/`：`desktop-before.log` 为修改前普通快捷键通过；`browser.log`、`desktop.log`、`experience.log`、`code-blocks.log`、`desktop-regression.log` 为最终回归。首次受限环境 Electron 加载失败，错误为 GPU 进程退出及 ERR_FAILED；窗口尚未进入测试，不将其描述成快捷键失败。随后在正常本机进程环境运行通过。失败只涉及该次隔离测试进程。

原 13895 预览沿用 `.local/preview-0.1.1`，确认已保存后刷新前端，显示快捷键入口；未重启后端、修改正文或创建测试笔记。刷新前后事件、版本头、附件绑定和选定配置摘要相同，证据为 `artifacts/preview-startup-shortcuts-before.json` 和 `artifacts/preview-startup-shortcuts-after.json`。已查看隔离界面截图和 `live-preview.png`。

未运行全量核心、多电脑同步或安装包验证；本轮未改动相关逻辑。未生成安装包、提交、推送或发布，已安装版本不会自动包含此次源码修改。
