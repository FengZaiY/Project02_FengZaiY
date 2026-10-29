# FengZai·Y 0.1.12 发布验证

日期：2026-10-27。Windows x64，本地 Node 24.16.0、Electron 42.11.12、electron-builder 26.15.3。所有测试使用隔离目录；正式资料、13895 预览、既有安装与外部已安装 Skill 未改写。

## 源码边界

本机 0.1.11 提交 a25106a106ca67257af33e1d833a474ba58728fe 保留。本轮功能与版本 86 个文件合为提交 **001d6ce152bcf38b296ae077d0a2b7c1818c50e6**，已推送 main。

排除并保留 0.1.4、0.1.5、0.1.6、0.1.8、0.1.9、0.1.10 的旧发布计划、版本说明及验证记录改动。发布后的交付记录留在工作区，不再改变固定提交或标签。

## 测试证据

| 检查 | 本轮实际结果 |
|---|---|
| `npm run check:project` | 提交前通过：95 必需文件、166 文档、251 本地链接及锁文件/命令契约 |
| `git diff --cached --check` | 提交前通过 |
| `npm test` | 首轮 345/346，一项 Agent 请求因动态端口触发 Node `bad port` 失败；源码不变完整复跑 346/346，0失败、取消、跳过 |
| 主回归批次 | `node scripts/test-local-audit.mjs release-0.1.12 ...`，28 个脚本首轮26通过；同步与设备失败另列 |
| 编辑补充批次 | `release-0.1.12-editor`，4 个脚本首轮3通过；原附件失败另列 |
| 同步界面 | 首轮第82行即时状态计数为0，单独原样复跑通过，保留失败日志 |
| 设备界面 | 原脚本寻找旧一级入口超时；独立副本只增加“多电脑同步→设备管理”进入路径，相同业务断言通过。原脚本本轮仍未通过，不记作原脚本成功 |
| 原附件界面 | 首轮浏览器分配端口6566，截图为 ERR_UNSAFE_PORT，catch 中读取不存在 modal 掩盖原错误；单独原样复跑通过 |
| 最终场景覆盖 | 31 个原界面/源码桌面脚本最终通过，另1个设备适配副本通过；总32项 |
| 打包后通用桌面 | 独立副本指向本轮 `release/0.1.12/win-unpacked/FengZai·Y.exe`，原断言通过 |
| 打包后个人业务桌面 | 独立profile验证实际CSV导出、密码剪贴板保护/清理、模拟锁屏与退出保存，通过 |

回归包括个人五板块、启动、业务保存竞态、完整业务操作链、Agent/MCP/Skill、在线更新、回收站、知识库、资料去重/路径、存储、层级/笔记树拖动、草稿、交互阅读退役、富内容/编辑体验、附件拖入/原附件、同步清单/发送接收/设备、接收目录/修改记录检查及源码桌面/退出/存储重启。

日志：

- `artifacts/release-0.1.12-core.log`、`release-0.1.12-core-retry.log`
- `artifacts/local-audit/release-0.1.12-results.json`、`release-0.1.12-editor-results.json` 及所列各脚本日志
- `artifacts/release-0.1.12-sync-ui-retry.log`、`release-0.1.12-attachments-retry.log`
- `artifacts/test-release-0.1.12-devices.mjs`、`release-0.1.12-devices-adapted.log`
- `artifacts/release-0.1.12-packaged.log`、`release-0.1.12-personal-packaged.log`

人工查看本轮个人任务桌面、财务窄窗及打包后媒体截图。测试副本与实际资料隔离；测试数据中的 AI 知识库名称不是默认预设。

## 构建与完整性

命令：

```text
npm run dist -- --config.directories.output=release/0.1.12 --config.electronDist=node_modules/electron/dist
node artifacts/verify-release-0.1.12.mjs
```

本地 Electron package 与实际 dist/version 均为42.11.12，复用锁定运行时避免重复下载，独立版本输出目录保留旧包。构建含 `--publish never`；日志 `artifacts/release-0.1.12-build.log`。

完整性脚本通过：161个构建输入、60个包内源码逐项核对固定提交；一个 CSS 只有CRLF/LF规范化差异。包内界面与本轮dist逐字节一致；来源固定GitHub；latest.yml的版本、文件名、大小和SHA512一致，blockmap可解析。

源码快照由固定提交git archive生成，362个文件逐项校验，附BUILD-PROVENANCE.json。后续交付文档及旧版本未提交交付记录不进入快照。结果见 `artifacts/release-0.1.12-integrity.json`。

| 附件 | 字节 | SHA-256 |
|---|---:|---|
| FengZaiY-0.1.12-Setup.exe | 111807540 | 159fa2588f1eab8b2143f1a1fbe72798a43bea0a3e51ad9855ec24be25fb1e46 |
| FengZaiY-0.1.12-Setup.exe.blockmap | 118769 | 65cc0dd161fb73d669683340e0766aeeaa430afd840a8d0dceca85adac235b59 |
| latest.yml | 348 | 42a07b40eb2d7d976b7b43715c1ff8ca0cb0e66849866abd6b60b4525e989269 |
| FengZaiY-0.1.12-source.zip | 1107683 | 6729638a0f05837bebc1fae8200aa10c8108786b6d142cc3d76471d956b8b135 |

SHA256SUMS.txt覆盖上述四文件，与安装包、blockmap、latest.yml、快照共五个发布附件。

## 标签与草稿

远端main与v0.1.12解引用均为001d6ce152bcf38b296ae077d0a2b7c1818c50e6；注解标签对象为aedc4f1da5aee18f053591862f869d08c7399cb8。首轮标签推送TLS握手中断，保持TLS校验重试成功，无强制推送或移动既有标签。

草稿地址：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-f6752e51f072e9781e8d

五附件全部上传完成。GitHub重读验证isDraft=true、tagName=v0.1.12、targetCommitish为完整固定提交；正文与本地notes-file一致，五附件state=uploaded，大小及远端digest逐项匹配本地SHA-256。证据：`artifacts/release-0.1.12-github.json`，校验脚本`artifacts/verify-release-0.1.12-github.ps1`。第一次重读TLS超时，保持原校验重试成功；不涉及重复创建或公开。未经用户明确确认不公开。

## 限制

Get-AuthenticodeSignature实际检查安装包及主程序均为NotSigned；builder日志提到signing不表示已有有效签名。真实安装、卸载和从旧安装版跨版本升级未验证，不能把解包程序测试当安装验证。品牌改名保留appId也不等于验证了跨版本升级体验。

format7要求所有同步电脑统一升级；旧数据兼容测试通过，真实百度上传及双机部署未实测。Windows锁屏为模拟，真实锁屏/休眠、断电和各第三方Agent宿主未逐一联调。上述失败、复跑及旧入口脚本差异均保留，不宣称一次全部通过。
