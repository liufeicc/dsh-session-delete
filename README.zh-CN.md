[English](README.md) | 中文

# dsh-session-delete

本地 DSH 组合包：在侧边栏会话菜单中加入一行 **Delete session（删除会话）**，
用于永久删除一个会话。

## 新增内容

- 在每个会话的“…”菜单中加入一行 `sidebar.workspaces.session.menu.item`
  （`id: session-delete`，order 500，紧随随附的 `archive` 行之后）。
- 一个 `shell.overlay` 确认对话框，其中点名该会话，因为此操作不可撤销。
- 一个 `sessionDeleteUi` **客户端服务**（`ctx.provide`），让别的客户端插件可以借用
  这扇确认框来删除会话，而不是重写一遍。第一个调用方是 `dsh-split-workspaces` ——
  它的窗格会话下拉在每一行会话末尾放了一个删除按钮。服务只有一个方法：
  `request({ sessionId, displayTitle, onDeleted })`；`sessionId` 不可用时返回 `false`，
  删除成功（或那个会话本来就没了）之后调用 `onDeleted(sessionId)`，平铺面板正是靠它
  把钉着这个会话的窗格一起松手。
- 一个 Host 操作，通过 Typert Gateway 以 Remote 端点 `sessionDelete/delete`
  暴露给浏览器。

## 行为

- 确认后会从磁盘删除该会话的持久日志目录
  （`$DSH_HOME/sessions/<project>/<session-id>/`），然后清除那些会让它继续被列出的
  派生状态：`session_projcache` 文件、置顶成员关系，以及所属工作区的
  `sessionIds` 记账。
- 侧边栏那一行会立即消失：工作区记账的变更经由既有的 Workspace 流到达，同时
  客户端会话列表会被告知这次移除（`handleSessionRemoved` 外加一次基线
  `refresh`）。
- **存活（live）不等于运行中（running）。** 一个只是被打开过一次的会话，只要
  Host 进程还在运行，就会一直保有一个存活的 Agent（以及它的日志写入句柄），
  所以旧的“此会话正在使用”这一拒绝逻辑几乎会让每一行的按钮都被禁用。现在，
  存活但空闲的会话会被删除：先对它做持久归档——也就是文档所述的唤醒阻断
  （wake block），因为 `agent/pre-step` 门禁读取的是持久归档集合——这样排队中的
  唤醒、一次 Goal Round 或 schedule 的定时触发都无法向被删除的日志追加内容并把
  它复活。正是出于这个原因，该归档 id 被有意保留下来作为墓碑（tombstone）；
  而没有存活 Agent 的会话则只是被取消归档。
- 只有真正**运行中**的会话会被拒绝，此时对话框会提供**停止并删除**：工作会按
  用户自己执行停止时的同样方式被取消，并在 Agent 归于静默后继续执行删除，
  因此不会有在途的 drain 重新创建正在被删除的那个文件。
- 已经消失的会话会以 `missing` 收场；对话框将其视为已完成，并清除那条过期的行。
- 通过 `sessionDeleteUi` 进来的调用方，是在客户端会话列表**已经**被告知这次移除之后
  才收到通知的；回调抛错只记日志，不算这次删除失败 —— 那时日志已经删掉了，把回调的
  错误报成「删除失败」是误报。

## 说明与限制

- Harness 没有删除会话的原语：会话持久化只会创建、打开、stat 和列出日志，
  而归档只会把一个会话隐藏起来。因此本插件自己删除这些产物，并止步于它无法
  安全完成的那一件事——删除一个此刻正在产出工作的会话。
- 删除你当前正在查看的会话，会让它已打开的对话视图指向一个不再存在的日志；
  归档门禁可让那个仍然驻留的 Agent 什么都不做，而刷新之后那一行就消失了。
  如果这个视图对你重要，请先切换到其他会话。
- Host 结果中的标记 `guarded: true` 表示该会话有一个存活的 Agent，因此归档
  保护了这次删除；`missing` 表示没有找到日志。
- 会话引用的附件按内容寻址，并与其他会话共享；它们不会被碰。
- 搜索索引（`dsh-session-query-sqlite`）会在自身对账时丢弃这个已消失的日志。
- 手工编写的组合包无法 `import` `@deepseek-ai/*` 包：profile 以链接方式指向
  本目录，Node 会解析出该链接包的真实路径，而 dsh 安装不在这个路径上。因此
  Host 半侧手工写入 Typert 标记与 `typertRemote` 绑定（也就是 `@Remote(...)`
  加 `TypertRemoteService` 通常会生成的内容），并通过 `ctx.provide` 注册该值；
  客户端半侧则为 `ctx.remote.$mount` 手工编写与之匹配的
  `InvocationDescriptor`。
- 这份手写描述符必须同时满足两条客户端规则：Gateway 挂载要求每个输入
  编解码器都是 `strict`（严格），而客户端 Typert 注册表还要求严格编解码器
  携带一个 `create()` schema 工厂。因此输入编解码器自带一个宽松的直通工厂，
  而没有任何环节会用它重新校验——Host 操作自行检查它的输入。去掉 `create`
  会让挂载被拒绝，对话框则报告删除尚未就绪。

## 文件

- `index.js` —— Host 半侧：删除操作、它做出的各种拒绝，以及手写的 Remote
  绑定。
- `client.js` —— 客户端半侧：菜单行、确认对话框、`sessionDeleteUi` 服务入口、
  Remote 挂载。
- `cordis.patch.yml` —— 插入唯一一条 Host 行。
- `locale/{en,zh}.json` —— 插件管理器显示元数据。
- `icon.svg` —— 插件管理器图标。

## 测试

三个测试都离线运行于已安装的 Harness，并且只使用临时目录：

- `node test/delete-contract.mjs` —— 针对伪造的 Context 验证操作自身的语义：
  运行中拒绝、对存活 Agent 的归档保护（及其墓碑）、目录发现、删除、清理步骤，
  以及 Remote 标记/绑定的形状。
- `node test/client-mount.mjs` —— 通过浏览器模块加载器加载 `client.js`，再用
  **真实**的客户端 Typert 注册表校验捕获到的 `$mount` 贡献，并把它挂载到
  **真实**的客户端 Gateway 上（传输层为桩），断言该命名空间对 `ctx.get` 可见，
  且调用以 `sessionDelete/delete` 的形式、携带 `request.sessionId` 与
  `request.stopActivity` 到达线上。它还包含一个反向对照（negative control），
  证明注册表会拒绝没有 schema 工厂的严格编解码器。此外它会像兄弟插件那样驱动
  `sessionDeleteUi`：空请求被拒、真请求被受理、用那个存储渲染出对话框、按下它的
  破坏性按钮，并断言这次 Host 调用与 `onDeleted` 通知都发生了。
- `node test/host-endpoint.mjs` —— 用**真实**的 Host Gateway 的 `invoke()`
  驱动真实注册表，从而在普通、缺失、拒绝运行和停止并删除四种情形下走通手写的
  SRC 发现路径，并真正删除会话日志目录。

当无法从 `$DSH_PROFILE_DIR` 解析 `@deepseek-ai/*` 时，每个测试都会跳过它依赖
Harness 的检查（并打印原因）。

## 开发

profile 以链接方式指向本目录（profile 的 `package.json` 中的 `link:`）。
客户端半侧直接从磁盘提供，所以编辑 `client.js` 后重新加载页面即生效。
Host 半侧是一个由 Loader 只导入一次的 Node 模块，而由于没有监视任何模块根
（`hmr.config.root: []`），**编辑 `index.js` 只有在 Harness 进程重启后才
生效**——重新挂载那一行只会重跑已缓存的模块，而不会重新读取文件。

## 许可证

本项目采用 MIT 协议发布，详见 [LICENSE](LICENSE)。
