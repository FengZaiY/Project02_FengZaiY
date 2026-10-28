# 纯文本代码块与目录树

日期：2026-10-28。用户希望笔记支持截图中的纯文本代码块，用字符保留目录树层级。

## 修改

- 沿用已有 Tiptap CodeBlock，不增加正文格式或运行脚本。插入菜单新增“纯文本 / 代码块”，原代码图标和快捷插入保留。
- 灰色底面、等宽文字、语言图标和复制反馈；移除块内 code 的行内背景/内边距，首行与后续行一致。长行默认在块内横向滚动，已有换行按钮可切换展示。
- 启用现有扩展的 Tab/Shift-Tab 两空格缩进，保留粘贴中的空格、空行、换行和制表符。复制按钮不包含工具栏文字。
- 继续保存 pre/code 与语言标识，工具和临时换行状态不写入正文。内置 API 补充 HTML/Markdown 表达说明。

## 本轮验证

- `node scripts/build.mjs` 通过。
- `node scripts/test-code-blocks-ui.mjs` 通过，日志 artifacts/code-blocks-ui.log：菜单插入、目录树粘贴、制表符不误变表格、缩进/取消缩进、撤销/重做、复制反馈、语言切换、保存重开、转义文本不执行、Markdown 围栏读取。
- 1220、931、600 宽度检查无页面横向溢出、长行块内滚动、自动换行不改变内容、编辑区底部可达。截图位于 artifacts/ui-code-blocks/code-*.png，已人工查看 1220 和 600 截图。
- `test:experience`、`test:ui`、`test:rich`、源码 `test:desktop` 通过。日志分别为 artifacts/code-blocks-experience.log、code-blocks-general-ui.log、code-blocks-rich-ui.log、code-blocks-desktop.log。
- 项目检查与 `git diff --check` 通过。本轮未修改核心持久化/同步逻辑，未重跑全量核心测试；不将前轮结果充作本轮证据。
- 新专项初次在 Markdown 对照处失败：测试忽略了现有 Markdown 渲染器在围栏内容末尾输出的换行。按实际格式约定修正断言后通过，未裁剪或修改正文来迁就测试。

## 预览与范围

原 13895 继续使用 G:\Project02_StudySelf\.local\preview-0.1.1，读取确认“测试”知识库仍在、界面协议为 3。HTTP 返回 app.js 与本轮 dist/app.js 的 SHA-256 一致，并核对已含新增菜单项。仅前端构建更新，无需重启后端；未在正式笔记中写测试内容。

保留工作区已有 MCP、更新下载和可读目录相关改动。本轮不生成安装包、不提交或推送，不改写外部已安装 Skill。当前功能不包含代码执行或语法着色，目录树仅为文本展示。
