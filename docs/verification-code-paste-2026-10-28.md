# 外部代码与目录树粘贴验证

日期：2026-10-28。用户反馈从其他应用/网页，无论复制按钮还是选择后 Ctrl+C，粘贴到普通正文时会丢失代码块格式。

## 原因与修改

此前专项只覆盖“先插入代码块再粘贴”。普通正文的纯文本粘贴走段落/TSV 解析，没有识别代码围栏或目录树；网页仅用 div、span 和 white-space 样式表示预格式化时，也未转换成编辑器代码节点。不能从该行为判断每个来源究竟提供了哪些剪贴板格式。

新增 web/code-paste.js：纯文本中的围栏交给已有 marked 解析；至少两个分支的目录树转成代码块，前后说明仍是段落。HTML 的 pre、独立多行 code、显式 pre/pre-wrap/break-spaces 转成标准 pre/code，保留文本中的空格、制表符、换行及语言。移除嵌在代码区的网页按钮，仍经过现有 HTML 清理与编辑器粘贴事务；不执行代码。

普通段落、行内代码、加粗和表格维持原路线。没有可识别标记的任意代码不猜测语言或格式，可先选择“纯文本 / 代码块”再粘贴。仅有视觉缩进而剪贴板中没有相应文本/格式信息时，不能承诺恢复来源的全部样式。

## 验证

- 文本识别单元测试 **4 项通过**：Unicode/ASCII 目录树、前后说明、制表符、换行规范化、多段 Markdown 围栏、转义及普通文字/表格不误判。
- 构建通过。浏览器专项通过：artifacts/code-paste-browser-final.log。
- 隔离 Electron 真实 Ctrl+V 专项通过：artifacts/code-paste-desktop-final.log，正常退出码 0。覆盖纯文本、普通 HTML 包装、围栏、pre/span/br、white-space/div、多次撤销/重做、保存重开、TSV 和代码不执行。剪贴板仅在仍与测试最后写入完全相同时恢复，避免覆盖用户后来复制的内容。
- 编辑体验、编辑快捷键、原代码块及通用界面回归通过：artifacts/code-paste-experience.log、code-paste-shortcuts.log、code-paste-code-blocks.log、code-paste-general.log。
- 1220/600 截图及无横向溢出检查通过，截图在 artifacts/code-paste；已查看桌面 600 宽度截图。
- 首次桌面专项在最后一次主进程剪贴板求值时返回 `Resulting promise was garbage collected`。保留 artifacts/code-paste-desktop.log；显式返回求值结果、单独复跑后通过，不能据此断言原生异常根因或所有来源兼容。

- 源码桌面通用回归通过：artifacts/code-paste-desktop-regression-final.log，退出码 0，覆盖安全 IPC、富编辑器、原生媒体、本机文件绑定及目录选择/迁移。首次启动超时（40 秒），未执行断言，保留 artifacts/code-paste-desktop-regression.log；核对并清理该次隔离测试进程后单独复跑通过，不据此推断启动超时根因。
- 最终项目检查通过：105 个必需文件、180 篇文档、273 个本地链接及脚本/锁文件一致性；git diff --check 通过。

本轮没有修改核心数据库、共享正文结构或同步协议，未运行全量核心测试，不引用前轮全量结果充作本轮证据。

## 交付范围

原 13895 仍指向 G:\Project02_StudySelf\.local\preview-0.1.1，“测试”知识库可见、界面协议 3，HTTP app.js 与当前构建 SHA-256 相同。只有前端更新，无需重启后端；未改正式笔记、外部应用设置或已安装 Skill。保留工作区其他任务改动，不打包、提交或推送。
