# FengZaiY 0.1.17 发布验证

2026-10-29，Windows x64，Node 24.16.0，Electron 42.11.12。仅准备草稿，未经用户明确确认不公开。

## 固定源码与范围

- 仓库：`FengZaiY/Project02_FengZaiY`。
- main 固定提交：`6d84cef15b5818439f9c8843413c465b3e5c5dd5`，功能及版本合并提交并推送。
- 注解标签：`v0.1.17`，标签对象 `7add1cf2e1d8ac9023bb74e6392af312f655da7b`，远端解引用为上述提交。
- 纳入更新下载原生逐跳适配、安全错误分类、安全更新说明和相关测试/文档；统一 package、锁文件及业务状态版本。既有历史发布文档修改保留并排除，仅补齐状态已有链接所需的 0.1.16 验证记录。
- 构建输入以 git archive 导出至 `artifacts/r17`，真实依赖从上一固定构建复制，未使用目录链接。交付后的报告和计划进度留在本机，不修改固定提交、标签或上传附件。

## 本轮实际验证

- `npm run check:project`、`git diff --check`：通过。
- 固定目录 `node --test tests/*.test.mjs`：395/395 通过，无失败、取消或跳过，336.5 秒。
- 固定目录构建及 `npm run dist -- --config.electronDist=node_modules/electron/dist`：成功，publish never。
- 更新界面、真实 Electron 更新下载、通用界面、启动、源码桌面、退出和包后桌面冒烟：全部通过，未使用临时测试适配器。
- 原生下载覆盖真实 301/302 跨源跳转、凭据剥离、取消、持久 Range 续传、重新下载、跳转循环/不安全地址拒绝、断流保留及 SHA512 错误拒绝；仅使用隔离文件，不执行安装程序。
- 已查看 600 宽更新界面截图，说明按标题/段落/列表排版，文字及操作可见，无横向溢出。脚本同时覆盖 1304、1001、600 宽，远端说明不加载外部资源。
- 完整性核验：202 个构建输入、77 个包内源码/Skill 文件、68 个界面产物及 457 个源码快照文件一致；包内来源为新仓库。latest.yml 安装包大小及 SHA512 与实际附件一致，blockmap 可解压解析；源码快照附 BUILD-PROVENANCE.json。

证据：`artifacts/r17/artifacts/release-tests.json`、各组 `release-*.log`、`update-download-desktop/report.json`、`ui-updates/*.png`；根目录 `artifacts/release-0.1.17-integrity.json` 与 `release-0.1.17-github.json`。

## 附件及草稿

本机目录：`release/0.1.17`。五附件已上传，远端状态 uploaded，逐个大小及 SHA256 与本机一致，草稿正文和目标也一致。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| FengZaiY-0.1.17-Setup.exe | 112240873 | c87284d22e77d10363e4c9179b5a75969b6f6fbf2d7cc1d749c0472bec8b6d79 |
| FengZaiY-0.1.17-Setup.exe.blockmap | 119111 | 607d903d98a667e1a07ad72e0a1b5311c66b65198b32f1bcb19394a9ecaf412b |
| latest.yml | 348 | 5897f9e03d05864613d9e062d8d62c5da19de1f17017a639c460e734a07ff10f |
| FengZaiY-0.1.17-source.zip | 1343363 | 8d8f4cdba8b7080ec3cfbcddb7a864bdf77038df3239b9b7e3982f0ffcb48611 |
| SHA256SUMS.txt | 363 | 清单覆盖以上四文件，清单自身远端摘要与本机一致 |

草稿地址：https://github.com/FengZaiY/Project02_FengZaiY/releases/tag/untagged-c036d3f4f7fc8e2cdf63

回读 isDraft=true、isPrerelease=false；未公开。本轮核对时 0.1.16 已由其他操作公开，不追改其历史交付记录。

## 实测边界

安装包及包内主程序 Authenticode 状态均为 NotSigned。真实安装、卸载、跨版本升级及真实双机传输未运行；包后启动和下载模拟不代替实际安装。未操作正式工作区、已有更新缓存或安装版。0.1.15 / 0.1.16 的下载故障不会因新草稿自动修复，需手动安装一次本修复版本。
