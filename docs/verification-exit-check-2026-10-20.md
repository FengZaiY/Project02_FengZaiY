# 桌面退出检查验证

环境：Windows，Node 24.16.0，源码 Electron；测试工作区位于 artifacts，未修改正式桌面资料。

- `node --test tests/exit-check.test.mjs tests/note-autosave.test.mjs`：最终 8 项通过，覆盖握手/过期请求、超时保留、已销毁渲染器、进行中写入、串行保存及不启用分支的显式重试。
- `npm run build`、`npm run test:exit`：通过。实际关闭事件触发检查；重复关闭和取消、未保存偏好、已有弹窗保留、后台笔记与当前草稿保存、冲突不覆盖/不创建分支、查看同步、退出后数据库落盘均验证。截图 `artifacts/exit-ui/saved.png`、`pending.png`、`conflict.png`、`preferences.png`；已查看最小桌面宽度下待保存及冲突界面。
- 首轮测试发现 Electron contextBridge 丢失异常自定义 code，已改为结构化结果并验证 CONFLICT。测试同步修正了偏好撤销确认、窗口重绘等待和进程退出后才读取数据库，未降低应用保护。

- `npm test`：235 项通过（追加渲染器发送失败用例后单独复跑以上 8 项）；`test:desktop`、`test:ui`、`test:editor`、`test:document`、`test:agents`、`test:updates` 通过。最终构建与 `test:exit` 再次通过。
- `npm run check:project`、`git diff --check`、Skill `quick_validate.py` 通过。已有未提交改动保留，没有提交或推送。

未打包、未替换已安装应用；浏览器预览不提供原生关闭握手，因此没有用刷新浏览器冒充桌面退出验证。未测试系统强杀、断电或操作系统注销；这些场景不等同于用户正常关闭窗口。
