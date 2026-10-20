# StudySelf 0.1.3 发布验证

日期：2026-10-20。环境：Windows x64、Node.js 24、Electron 42.11.12。

## 来源与版本

- 起点工作树干净；本地 HEAD 与远端 main 均为 `6b1be4edd98682c873f1a4509e5709caa4831669`。
- 旧公开标签 v0.1.2 为 `d2f7460866bf1d57c71054280ac95deff3c1f24a`。
- 本轮仅修改 package、锁文件、业务状态版本及发布文档，不改业务行为。
- 版本为 0.1.3；未自动提交或推送，公开前须重新核对标签目标。

后续用户明确授权提交并推送本次版本修改。推送前核对远端 main 仍为构建起点，无并发新提交；本次提交仅含版本与发布文档。推送后核对远端提交及包内源码，Release 仍不公开。源码 ZIP 保留冻结来源，不修改已上传文件。

## 本轮通过

- `npm test`：224/224。
- `node --test tests/permanent-deletion.test.mjs tests/trash.test.mjs tests/current-sync.test.mjs tests/storage.test.mjs tests/retired-ai.test.mjs`：54/54。
- `npm run build`、`npm run check:project`。
- `test:ui`、`test:trash`、`test:libraries`、`test:assets`、`test:agents`、`test:skills`、`test:storage`、`test:updates`。
- `test:desktop`、`npm run dist`、`test:packaged`。
- 已查看 `artifacts/trash-ui/cleanup-600.png`、`artifacts/ui/retired-ai-cleanup-600.png`：版本、清理状态及底部入口可见，无明显重叠。

日志为 `artifacts/release-0.1.3-*.log`。测试均使用隔离资料，不操作正式工作区。

## 产物核验与草稿

构建安装包、blockmap 和 latest.yml；固定更新源为公开 GitHub `FengZaiY/Project02_StudySelf`。冻结快照与校验清单由 `artifacts/verify-release-0.1.3.mjs` 生成，逐字节比较所有已跟踪核心/桌面/Skill 源文件及 dist，验证包内版本、来源、feed 大小及 SHA512、blockmap 可解析性。最终结果保存 `artifacts/release-0.1.3-integrity.json`。

冻结时 GitHub 草稿与附件上传尚待完成，后续草稿保存结果记录在项目状态及计划；不重新生成已上传快照。当前禁止公开，标签应在版本提交后重新核对。

冻结后的交付核验：42 个核心/桌面/Skill 源文件及全部 dist 一致，feed 和 blockmap 校验通过，四份冻结文件 SHA256 匹配。安装包 SHA256 为 `7df86e6a840a561029686a950a8389c16d49fa2c842fd67f349a8b952fa346c9`。

GitHub 草稿已保存，重新加载确认未公开提示及全部五个附件。地址为 `https://github.com/FengZaiY/Project02_StudySelf/releases/edit/untagged-00aaed34296a73f18af6`，截图 `artifacts/release-0.1.3-github-draft.png`。源码 ZIP 保持冻结时内容，此段交付结果不回填 ZIP，避免上传后改变哈希。

## 未验证范围

- 安装包与程序 Authenticode：`NotSigned`，未配置证书。
- 未运行真实安装、卸载、跨版本安装升级或双机部署；打包运行不等于安装验证。
- 未运行本次变更无关的全部富内容专项和性能基准，不复制 0.1.2 历史测试结果。
- 不验证百度账号/客户端的云端历史删除，不承诺外部副本全部擦除。
