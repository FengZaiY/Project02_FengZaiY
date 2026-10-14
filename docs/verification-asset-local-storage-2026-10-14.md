# 资料本机存放位置验证

日期：2026-10-14。环境：Windows、Node.js 24.16.0、Playwright。功能测试使用隔离资料，未生成安装包。

## 实现范围

- 资料页显示当前工作区根目录和可折叠的本机目录树，按实际附件绑定展示知识库、笔记、共享资料及回收资料等位置；不按笔记标题猜测路径。
- 点击目录或资料行的位置筛选附件，可与知识库、搜索及现有筛选共同使用。目录数量在分页前统计；切换知识库清除目录条件。
- 详情显示完整文件路径、实际文件名和目录，可复制文件、目录及根目录位置。桌面打开根目录复用既有系统入口。
- 缺失、内容变化、未绑定及工作区外位置分别展示。本机路径只供受信任界面读取，不进入共享知识版本或外部 Agent 返回。
- 展示和筛选不扫描系统目录，不移动原件，不写入知识记录。

## 本轮结果

| 命令 | 结果 |
|---|---|
| `npm test` | 182/182 通过 |
| `node --test tests/asset-management.test.mjs` | 9/9 通过；含真实层级、共享/回收、缺失/变化/未绑定/外部绑定、范围隔离、分页前计数及只读检查 |
| `node --test --test-name-pattern='attachments enforce hashes' tests/agents.test.mjs` | 1/1 通过；受信任详情包含路径，Agent 记录不包含本机存储投影或目录 |
| `npm run build` | 通过 |
| `npm run test:asset-storage` | 通过；目录层级、筛选、复制、库切换、折叠、异常状态、无知识写入及多窗口布局 |
| `npm run test:assets`、`npm run test:asset-previews` | 通过 |
| `npm run test:ui`、`npm run test:libraries` | 通过 |
| `npm run test:agents`、`npm run test:attachments`、`npm run test:dedup` | 通过 |
| `npm run check:project`、`git diff --check` | 通过 |

专项首次运行暴露测试等待问题：异步复制完成前读取剪贴板，以及详情加载前访问旧的隐藏弹窗。测试改为等待剪贴板实际内容和可见详情后通过，未放宽功能断言或修改生产行为绕过问题。

检查了 1220/931/600 宽度截图，包括目录树、列表、完整路径弹窗及底部分页可达性。窄窗口表格内部滚动，页面无横向溢出。报告位于 `artifacts/asset-storage-ui/report.json`，截图包括 `directories-1220.png`、`directories-600.png`、`list-931.png`、`detail-600.png`。

## 原工作区

核对原 13895 端口的启动锚点、实际根目录、占用锁与进程后沿用原入口更新预览，打开“资料与附件”确认新目录显示。更新前无未保存标签、待切换存储位置或待执行目录任务。

前后均为 174 条修改记录，知识库、当前分支及记录摘要一致；6 项正常附件、1 项回收附件，7 个原文件的路径和 SHA-256 全部一致。正常附件实际位于 AI人工智能知识库的 ChatGPT 笔记资料目录。本轮未执行附件合并、回收、移动或删除。

证据为 `artifacts/asset-storage-preview-before.json`、`artifacts/asset-storage-preview-after.json` 和原页面截图 `artifacts/asset-storage-original.jpg`。

## 未验证与边界

本轮未运行桌面测试、安装包测试、真实百度双机联调或大规模性能测试；未生成安装包。桌面打开根目录沿用既有能力，本轮没有桌面代码改动。目录树展示已管理附件的真实绑定，不是任意系统文件浏览器；嵌套分支的折叠状态在列表重新加载时重置。
