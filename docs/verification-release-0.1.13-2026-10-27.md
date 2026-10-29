# FengZaiY 0.1.13 发布验证

日期：2026-10-27。Windows x64，Node 24.16.0、Electron 42.11.12、electron-builder 26.15.3。测试均使用隔离目录，不改写正式工作区、13895预览、既有安装及外部已安装Skill。

## 源码与范围

开始时本机与远端main均为001d6ce152bcf38b296ae077d0a2b7c1818c50e6，GitHub的0.1.12已公开。本轮FengZaiY命名统一、旧身份/路径/引用兼容与format8预检及版本修改，共103个文件合并为提交 **756d78b8576cbfd3636bec38d9f0b7982885a6cf**，已推送并重读远端main核对一致。

旧0.1.4、0.1.5、0.1.6、0.1.8、0.1.9、0.1.10、0.1.12独立交付记录改动保留并排除。后续交付记录不进入固定源码快照，不再次提交或移动标签。

## 构建与校验

```text
npm run dist -- --config.directories.output=release/0.1.13 --config.electronDist=node_modules/electron/dist
node artifacts/verify-release-0.1.13.mjs
```

本机Electron package和dist/version核对均为42.11.12，复用已锁定运行时，独立版本输出目录保留旧包。构建使用--publish never，没有自动上传。

165个构建输入核对固定提交；其中web/personal-pages.css仅CRLF/LF换行规范化差异，正文完全一致。62个包内源码文件逐字节匹配固定提交，包内dist匹配本轮界面构建。新Skill目录为skills/fengzaiy，包内不含旧studyself-organize目录；包名fengzaiy、产品FengZaiY、appId与固定NSIS GUID配置符合预期。固定GUID的代码校验不等于真实跨版本安装已验证。

更新来源仍为FengZaiY/Project02_StudySelf；latest.yml版本、文件名、字节数与SHA512正确，blockmap可解析。源码快照从git archive固定提交生成，372个文件核对后附BUILD-PROVENANCE.json。

证据：artifacts/release-0.1.13-build.log、artifacts/release-0.1.13-integrity.json及校验脚本。

| 附件 | 字节 | SHA-256 |
|---|---:|---|
| FengZaiY-0.1.13-Setup.exe | 111807952 | 100ef36e7aa4d21117a4f7719052f41339fa5afa16b9524288b9ed2dc7f8de8e |
| FengZaiY-0.1.13-Setup.exe.blockmap | 119036 | cd1039c024dbab846df0d52fd25d1d43fa4573c450eac0ae9a6ba4cba1c6ebb2 |
| latest.yml | 348 | 483ae3f2e558e23223b8f723bcfcf5363e151a1870614ef9d56e5b0537f77908 |
| FengZaiY-0.1.13-source.zip | 1126911 | f89c8afe5a32ae7ecf7d381fb542b729090b78b29d7d5c0c8b26e3265ce44a4d |

SHA256SUMS.txt覆盖上述四文件，与其共同组成五个发布附件。

## 测试

- 提交前npm run check:project通过：95必需文件、171文档、260本地链接及命令/锁文件契约；暂存差异检查通过。
- 首轮npm test：357项中356通过，密码库确认/恢复/闲置锁定一项报Deriving bits failed。源码及加密参数未改变，使用node --test --test-concurrency=2 tests/*.test.mjs复跑完整套件，357项全部通过，0失败、取消或跳过。首轮耗时460.5秒，复跑851.7秒。首轮异常不抹除，不仅凭重试推断根因。
- 浏览器与CLI批次共25个脚本全部通过（24浏览器、1真实CLI启动）；日志及browser-results.json在artifacts/release-0.1.13-tests/。覆盖命名、启动、通用/个人界面、Agent/Skill、更新、富内容/导图/编辑、附件/拖动、资料/存储/层级/草稿/回收站及同步界面/清单占用。
- 源码Electron桌面、个人业务、退出与审查修复4个脚本全部通过；desktop-results.json记录实际退出码。
- 原设备测试仍指向旧一级导航。本轮独立副本仅适配“多电脑同步→设备管理”进入路径，原业务断言保留，改名、停用/恢复、转移/取消/接管及窄窗全部通过；不把适配结果冒充原脚本通过。证据为artifacts/test-release-0.1.13-devices.mjs及release-0.1.13-devices.log。
- 两个打包后测试通过：独立副本仅调整本轮可执行路径、输出目录及fixture相对位置，验证原生媒体、加密凭证、MCP/Skill、SQLite、IPC、存储迁移、导出、密码剪贴板、模拟锁屏及退出保存。
- 查看本轮MCP配置、Skill管理及打包后媒体截图，新名称和版本正确、内容可见。截图中的知识库为隔离测试数据，不是新用户预设。

首轮/复跑核心日志为artifacts/release-0.1.13-core.log、release-0.1.13-core-retry.log。打包后日志为artifacts/release-0.1.13-packaged.log与release-0.1.13-personal-packaged.log。

## 标签与GitHub草稿

已推送注解标签v0.1.13，标签对象9a3e1c26969430bd179a196a8e87b7a2ef47d8b6；远端解引用及main均为756d78b8576cbfd3636bec38d9f0b7982885a6cf。

草稿：https://github.com/FengZaiY/Project02_StudySelf/releases/tag/untagged-65894927a89e59cd046a

首次gh release create创建草稿成功，四个小附件上传完成，安装包被GitHub uploads返回HTTP408（Upload body timed out due to inactivity）。重读确认isDraft=true、目标正确且安装包缺失；只单独补传安装包，不重复创建Release，补传成功。

最终重读验证isDraft=true、tagName=v0.1.13、targetCommitish为完整固定提交；正文与本地notes-file一致，五附件state=uploaded，大小及远端digest逐项匹配本地SHA-256。证据为artifacts/release-0.1.13-github.json及artifacts/verify-release-0.1.13-github.ps1。未经用户明确确认不得公开Release。

## 兼容与限制

新fengzaiy://引用及导图元数据要求format8，所有参与同步的电脑须升级。旧格式继续读取，含新引用的旧冻结计划须取消重建。旧Skill目录暂停自动更新，导出新包安装fengzaiy后重新关联；不改写外部配置。

Get-AuthenticodeSignature实际检查安装包及主程序均为NotSigned。真实安装、卸载和从旧安装版跨版本升级未验证；源码GUID检查及打包后运行不能替代安装验证。模拟锁屏不等于真实Windows锁屏/休眠验证。

同步仅使用隔离目录，未操作真实百度账号或客户端，不宣称云端上传和真实双机部署已实测。第三方Agent宿主未逐一联调。正式公开前等待用户核对。
