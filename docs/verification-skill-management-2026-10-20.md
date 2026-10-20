# 内置 SKILL 管理验证

日期：2026-10-20。环境：Windows、Node 24.16.0、StudySelf 0.1.1 开发源码。用户确认仅管理内置 StudySelf Skill，不增加自定义 Skill。

## 功能与保护

系统设置顶部入口定位到专门的 SKILL 管理区。文件预览来自固定白名单，作为文本展示，不执行脚本或扫描外部安装目录。内置内容版本与 bootstrap 一致，偏好独立保存；文件预览、偏好编辑、偏好历史和导出在同一区域操作。

历史取回先填入编辑区，保存时创建新不可变记录；保留原历史。切换页面保留未保存编辑，刷新/关闭页面使用未保存提示。保存期间的新输入保留，过期保存拒绝覆盖，可取消或对照最新版本后明确选择当前编辑保存。偏好冲突时禁止导出，外部写入继续使用原偏好冲突保护。

`agentSkillExport` 仅受信任界面可调用，生成当前文件/偏好快照并保存本机生成信息。ZIP 中的 `manifest.json` 含内置版本、偏好版本、组合导出版本和协议号；不含凭证、授权哈希或本机路径。生成状态不声称已安装到外部 Agent；用户补充或内置文件变化后显示需重新导出。不修改已有共享实体结构或同步格式。

## 已执行

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm test` | 200 通过，0 失败，日志 `artifacts/skill-core.log` |
| `npm run test:skills` | 通过，日志 `artifacts/skill-manager-ui.log` |
| `npm run test:agents` | 通过，日志 `artifacts/skill-agents-ui.log` |
| `npm run test:ui` | 通过，日志 `artifacts/skill-general-ui.log` |
| `npm run test:libraries` | 通过，日志 `artifacts/skill-libraries-ui.log` |
| `npm run check:project` | 通过 |
| Skill `quick_validate.py` | 通过 |
| `git diff --check` | 通过 |

新增核心用例验证 bootstrap 版本一致、偏好改变使导出版本变化、逐文件 ZIP 内容/manifest、旧导出记录保留、导出不生成知识修改记录、历史恢复追加记录、过期写入/冲突导出拒绝及真实 HTTP Agent 无管理权限。

界面专项验证文件只读、未保存时阻止导出、跨页保留文本、实际 ZIP 下载内容、历史取回后再保存、保存期间输入、远端新版本对照/取消/明确保存、重开保留结果。检查 `artifacts/ui-skill-manager/` 中 1304/1001/600 窗口截图，人工查看 `files-1001.png`、`preferences-600.png` 及原页面。页面无横向溢出、状态栏与保存控件可达。

## 预览与范围

原 13895 服务核对根目录和进程后重启，刷新前确认没有未保存正文、标签或偏好。真实页面只查看管理区，不保存偏好或执行导出。校验 18 个实体、190 条修改记录、当前分支与 7 个原文件哈希不变；证据为 `artifacts/rich-layout/skill-management-2026-10-20-before.json` 和 `after.json`。

未运行桌面进程、安装包及真实双机测试，未生成安装包。未验证或修改任何外部 Agent 安装状态，未连接真实云服务或付费模型。
