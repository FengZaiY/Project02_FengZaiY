# 发布清单文件占用修复验证（2026-10-24）

## 问题与范围

用户截图显示最后更新 `current-<device>.sscurrent` 时出现 EPERM rename，临时完全退出百度客户端后继续发布成功。该结果支持客户端运行期间的文件占用/访问冲突，但未在用户家里取得具体占用句柄证据，不能把所有 EPERM 都归因为百度。

新增 `src/core/sync-publication.mjs`，仅用于当前发布清单写入。保留普通 `atomicWrite` 及其他不可变对象写入，避免扩大变更范围。先生成并刷盘一份加密临时清单，再对 rename 的 EPERM/EACCES/EBUSY 做最多 7 次异步重试。等待序列为 200、400、800、1600、2000、2000、2000 毫秒，累计计划等待 9 秒（不承诺操作系统调度下的总墙钟耗时），等待分段检查暂停。磁盘不足等其他错误不重试或冒充文件占用。

旧清单不会先被删除；替换成功后才更新最近发布、exported 标志和生成完成状态。持续失败/暂停保留任务；重启后继续沿用冻结内容，等待期间的新编辑留给下次发布。临时文件清理失败不覆盖原错误，明确告知保留；加密 `.partial` 不参与完整发布发现。没有扫除历史临时文件、chmod、终止客户端、协议变更或新增 Agent 权限。

界面通过本机进度的 `phase` 区分“正在处理”和“正在更新最新清单”，展示重试次数和暂停入口。对象 1/1 不再是唯一进度信号。持续失败给出解除占用及继续发布提示，仍不声称云端已上传。

## 验证

环境：Windows，Node 24.16，仓库现有依赖；全部测试使用隔离资料，未触碰真实百度同步目录。

| 检查 | 结果 |
|---|---|
| `node --test --test-timeout=120000 tests/sync-publication.test.mjs tests/current-sync.test.mjs` | 30 项通过 |
| 全量 `node --test --test-concurrency=2 --test-timeout=180000 --test-reporter=spec --test-reporter-destination=artifacts/sync-contention-core.txt tests/*.test.mjs` | 308 项通过，0 失败/取消/跳过，约 309 秒 |
| `npm run build` | 通过，仅开发构建 |
| `npm run test:sync-publication` | 通过，等待/暂停/持续失败/继续，旧清单字节保留及 1165/600 窗口 |
| `npm run test:ui` | 通过，编辑/范围/同步/部分确认/过期保存 |
| `npm run test:desktop` | 首次 Electron 启动 40 秒超时；原命令隔离重跑通过，包括原生媒体、安全 IPC、目录迁移及原件保留 |
| `npm run check:project`、`git diff --check` | 通过 |

专项覆盖三个可重试错误、持续锁定的有限次数、非占用 I/O 错误不重试、临时文件创建失败、清理失败保留原始原因、等待时暂停、进程重开继续、重复发布互斥、旧清单不变、冻结内容与等待期间新编辑隔离，以及另一隔离工作区拉取/重复拉取。

Windows 原生测试由 PowerShell 打开临时目标文件的只读句柄，不授予 delete sharing。未注入 rename 错误，真实文件占用触发重试后释放句柄，替换成功。此测试验证 Windows 文件行为，不冒充真实百度双机联调。

界面专项初次定位按钮时匹配到了两个同步入口，修正为准确可访问名称后通过，未据此改变产品。已查看 `artifacts/sync-publication-ui/waiting.png`、`blocked-600.png`，等待/处理提示可读，窄屏未横向溢出。界面结果保存于同目录 `report.json`。

## 预览与边界

核对原预览端口无监听、旧锁对应进程已退出，原启动记录及锚点指向 `.local/preview-0.1.1`。以该入口恢复 13895 预览，没有另建空库。启动前后 7 条事件、2 个版本头及附件绑定摘要完全一致；证据为 `artifacts/sync-contention-preview-before.json` / `sync-contention-preview-after.json`，HTTP 界面入口正常，运行中根目录与原目录一致。

本轮未提交、推送、打包、修改安装程序或真实同步文件。版本号保持 0.1.9，不意味着已有 0.1.9 安装包包含这次新增修改。家里电脑安装后及真实百度传输尚未验证。短暂占用可自动恢复，持续占用或权限不足仍需解除后继续；不承诺无需处理所有占用情况。
