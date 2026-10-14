# Word 附件预览验证

日期：2026-10-14。Windows、Node 24.16.0、锁定的 Playwright/Chromium 与 Electron。所有写入测试使用隔离资料；原资料仅通过界面阅读。

## 实现

原 DOCX 没有预览转换，落到“本机应用查阅”占位；原附件列表较长时，占位位于可见区域下方。现增加本地 Mammoth 1.13.0 转换与 JSZip 3.10.1 解压限量，原通用 MIME 根据文件扩展名兼容。解析 Worker 可取消、20 秒超时，解压按实际输出限制为 64 MiB/2,000 项，结果 HTML 限制为 12 MiB，文件读取沿用现有 24 MiB 上限。

关闭外部文件访问与文档嵌入样式映射，DOMPurify 白名单清理生成 HTML，图片只接受内嵌 PNG/JPEG/GIF/WebP，外部链接不可执行。阅读 iframe 使用 `sandbox=""` 和内部 CSP，无脚本/同源权限。最初 Blob URL 在隔离 Chromium 和 Electron 正常、实际内置浏览器空白；改为 `srcdoc` 后三个环境均显示内容，没有关闭安全配置。

点击原附件后将预览滚入可见区，支持返回列表和放大；正文链接及资料目录复用入口。请求序号、取消信号、面板/弹窗连接检查阻止旧响应覆盖新选择；关闭移除 iframe，取消 Worker 并释放资源。取消中的侧栏显示可重试状态，不遗留无限加载。

## 测试结果

| 命令 | 本轮结果 |
|---|---|
| `npm run build` | 通过 |
| `npm test` | 182 项通过 |
| `npm run test:docx-preview` | 通过，最终取消处理后重跑通过 |
| `npm run test:attachments` | 通过 |
| `npm run test:attachment-drag` | 通过 |
| `npm run test:assets` | 通过 |
| `npm run test:ui` | 通过，最终修改后重跑通过 |
| `npm run test:agents` | 通过，含偏好和 Skill 导出 |
| `npm run test:desktop` | 通过；沙箱内渲染进程无法启动，授权后用隔离资料运行，验证 Word 文字/表格与隔离页面；`srcdoc` 调整后再次通过 |
| `npm run check:project` | 通过，58 项必需文件、74 份文档、116 个本地链接 |

专项覆盖：中文正文、加粗、标题、列表、表格、内嵌图片，旧 MIME，脚本链接与外部链接不可执行，无外部网络请求，损坏文件、重试、压缩后小但解压超限文件，长列表预览可见、放大/关闭、快速换附件、延迟响应、关闭中读取、Worker 回收，正文链接预览、编辑器身份与撤销保留、原附件哈希和修改记录不变。

查看 `artifacts/docx-preview/side-1001.png`、`expanded-1001.png`、`expanded-600.png` 与 `artifacts/desktop/docx-preview-native.png`；专项另保存 1220 窗口截图，检查无页面横向溢出。截图使用构造的学习资料，不把用户文档提交到仓库。

## 实际预览

核对原工作区后重启 13895 服务，继续使用原启动锚点与 `.local/preview-0.1.1`。刷新前已确认没有未保存编辑。实际打开用户指出的 Word 附件，读取页包含 3,927 个文本字符、1 个表格和 77 张加载成功的内嵌图片；放大后已查看实际显示。未修改用户笔记或原文件。

重启及打开前后，174 条修改记录、16 个实体、全部当前分支和 7 个原文件哈希一致。只读校验位于 `artifacts/rich-layout/docx-preview-before.json` 和 `docx-preview-after.json`。

## 边界

预览按内容重排，不承诺原版分页、浮动图形、全部公式/图形对象或旧 `.doc` 格式。链接文字保留但不在阅读页主动打开外部地址。未运行安装包验证，未生成安装包。没有用用户原件测试损坏、超限或修改。
