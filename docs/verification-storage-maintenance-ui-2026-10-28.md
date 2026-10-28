# 资料浏览与存储维护界面验证

日期：2026-10-28。范围见 [实施计划](plans/2026-10-28-storage-maintenance-ui.md)。

## 结果

- 资料页以分类/主题为主，用途集合折叠显示；集合筛选、创建和编辑保留，materialCollection 身份、协议和原件路径不改变。
- 当前路径、打开目录、统一更换工作区保留在本地存储。浏览器不具备打开资源管理器的原生能力，按钮禁用并标明桌面版可用；复制路径仍可用。
- 统一扫描逐项调用既有只读预览和状态接口，显示当前根目录。空间只统计已校验副本；接收断点和未知文件不计为可释放。任何检查失败明确提示部分未完成，其他结果仍可查看。
- 清理仍由各自预览/确认及后端令牌重验执行，不合并为一键删除。执行后重扫刷新状态；离开设置后取消后续界面扫描步骤，不把返回结果写入新页面。
- 高级维护默认折叠，根据内部布局与资料迁移状态显示待处理数。完成的永久删除、资料迁移和接收整理不继续提供重试。未知接收文件及续传文件仍保留。

## 验证

- npm run build：通过。
- scripts/test-storage-maintenance-ui.mjs：通过。验证折叠集合、单一工作区入口、扫描不提交写操作、部分失败/转义、待处理与完成按钮、1304/850/600 布局。
- scripts/test-storage-ui.mjs：通过。保留未保存编辑、目录检查、取消、切换、迁移重启及旧副本确认清理。
- scripts/test-trash-ui.mjs：通过。保留搜索无关范围、过期确认、引用保护、回收/空目录确认和已完成状态。
- scripts/test-received-objects-ui.mjs：通过。分页、续传、未知文件保留、空目录收尾及未保存偏好保护。
- scripts/test-assets-ui.mjs：通过。资料属性、身份、筛选、引用保护、批量回滚、历史及布局。
- scripts/test-personal-ui.mjs：通过。五板块与用途集合创建/重载。
- scripts/test-readable-storage-ui.mjs：通过。分类/主题创建、整理方案确认及实际可读落盘。
- Skill quick_validate.py 使用 Python UTF-8 模式通过。
- npm run check:project：105 项必需文件、187 份文档及 281 个本地链接检查通过；git diff --check 通过。
- 已查看 artifacts/storage-maintenance-ui/settings-1304.png 与 artifacts/ui-received-objects/received-600.png，路径换行、按钮和分组可见。其余截图分别保存在上述脚本对应 artifacts 目录。
- 只读比对 13895 的 app.js 与 dist/app.js 完全一致，原预览服务可直接提供本轮界面，无须切换工作区。

## 首轮问题与边界

新专项测试首次点击导航后立即读取可见性，改为等待资料页就绪。接收目录旧测试直接拼根目录/received-objects，修正为 workspaceInternalPath，与迁移后的真实布局一致。资料筛选测试仅等待网络响应、个人任务新建测试在旧表单消失前填写，分别改为等待对应结果行和新空表单；复跑通过，未因此修改无关业务行为。Skill 校验首轮受 Windows GBK 默认编码影响，显式 UTF-8 后通过。

本轮未运行全量核心测试或真实安装版回归；正式资料未迁移/删除，未提交、推送、打包或更改版本号。已有其他任务修改保留。
