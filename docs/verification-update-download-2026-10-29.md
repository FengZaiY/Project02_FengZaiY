# 安装版下载失败验证

2026-10-29，源码0.1.16，Windows，测试Electron42.11.12。用户截图为0.1.15检查到0.1.16后0字节失败，并出现HTML更新说明。仅源码和预览交付，不操作正式业务资料、已有更新缓存或安装程序；不提交、推送、打包、发布或改写已发布附件。

## 原因与证据

旧UpdateDownload用`net.fetch(..., {redirect:'manual'})`期待得到302响应，然后自行读Location。真实Electron隔离服务中，直连文件成功，同一文件经302立即抛出无code的`Redirect was cancelled`，因此被UpdateManager折叠成NETWORK_OR_FILE_ERROR。初始原生下载专项只测直连，没有覆盖GitHub的跳转链；这是测试覆盖缺口。

截图中旧仓库地址会先301到更名后仓库，再302到下载服务器。公开latest.yml可读，标记版本0.1.16、安装包112238898字节。GitHub API首次查询遇到未认证限流，没有使用或打印凭据；随后通过公开发布文件核对，没有改动发布。不存在足以从截图认定磁盘不足的证据。原安装程序未配置持久化下载错误日志，实际内部错误依据同代码同运行时复现推定，并非读取到用户当时的完整堆栈。

Electron官方源码`lib/browser/api/net-fetch.ts`也显示manual参数直接交给ClientRequest而没有redirect处理。修复使用net.request显式返回每一跳响应并停止当前请求，再由现有下载器校验下一个地址；不改成不受检查的自动跟随。新适配保留流式背压和取消，跨源移除认证/Cookie，不使用不安全协议或绕开代理的替代网络库。

## 改动

- 新增update-network，桌面更新入口使用原生逐跳适配。现有暂停/继续、精确重下、Range和完整SHA512后提升安装包的规则保留。
- 更新失败提供网络、跳转、超时、权限/占用、磁盘和完整性分类；只显示错误标识和固定文案，不返回签名URL、真实路径或远端正文。
- 更新说明使用现有Markdown解析和DOMPurify白名单，仅保留文字排版；禁止脚本、样式、图片、iframe、链接及属性，不发起远端资源请求。

## 验证结果

- `node --test tests/updates.test.mjs tests/update-download.test.mjs tests/exit-check.test.mjs`：19/19通过。包括真实NSIS更新库下载/取消/重下与校验，但不执行安装程序。
- `npm run test:updates-desktop`：真实Electron下直连及301→302跨源、取消后持久Range续传、跨源凭据剥离、等待响应与跳转时取消、循环/不安全地址拒绝、断流4096字节保留后继续、错误SHA512拒绝，全部通过。结果在`artifacts/update-download-desktop/report.json`。
- 实际GitHub旧安装包地址经过301、302后取得206；读取且仅读取前1024字节并核对总大小及MZ头。不代表已完成整个安装包下载、签名或真实升级。结果在`artifacts/update-github-diagnosis/report.json`。
- `npm run build`、`test:updates`、`test:ui`、`test:desktop`、`test:exit`通过。更新界面验证HTML/Markdown呈现、远端脚本/资源阻断、错误恢复、偏好和未保存编辑保护、1304/1001/600宽度。已查看600宽截图，无遮挡，更新说明正常排版。
- 未运行全量核心及安装包测试；本轮不改数据库、同步或知识记录。已安装程序和公开0.1.16附件不随源码变化，需要后续发布修复包并手动安装一次。

## 预览与维护

`npm run check:project`与`git diff --check`通过。原13895核验进程后沿同一`.local/preview-0.1.1`锚点重启，界面构建摘要吻合，服务版本0.1.16、UI协议4、原“测试”知识库保留。事件、版本头、附件及关键本机配置摘要一致，浏览器只读打开无启动/页面异常。报告在`artifacts/update-preview-before.json`和`update-preview-after.json`。安装版进程、安装文件和用户现有更新缓存未修改。
