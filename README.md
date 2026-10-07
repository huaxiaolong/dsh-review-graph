# dsh-review-graph

把一次变更渲染成**可点击的关系图**，并把每个节点连到确切的源代码行——一个
[DSH](https://github.com/huaxiaolong) 插件（Host + Client 两半，无运行时依赖）。

* **总览图**：按调用深度分列的车道网格（**结构上不可能重叠**），细连线表示调用关系，单击文件即在审查面板打开该文件；
* **审查面板**（右侧栏）：来源切换（未提交 / 未暂存 / 已暂存 / 单个 commit / 分支对比）、左右双列行号、Prism 语法高亮（内联 297 种语言）、跳转行左侧标记；
* **业务流程（AI）**：按需生成、原版 / 改动后左右对照的**流程图**，节点带文件与行锚点，**只在点击生成时才消耗 token**；
* 缓存分三层（页面内 / Host 内存 / 落盘），材料变了**不会清空**上一次结果，只标「已过期」由你决定是否重新生成。

## 要求

* DSH（Host + Web 端），profile 方式安装；
* Node.js ≥ 20（仅开发/自检需要；插件运行时不依赖 Node API 之外的包）；
* 被审查的工作区是一个 git 仓库（非 git 目录会明确提示，而不是静默空白）。

## 安装

```bash
# npm（推荐）
dsh plugin --profile <profile> add dsh-review-graph

# 或从 git
dsh plugin --profile <profile> add https://github.com/huaxiaolong/dsh-review-graph

# 或本地目录（开发时用，改完需重启 Host / 刷新页面）
dsh plugin --profile <profile> add <本仓库路径>/dsh-review-graph
```

安装后**重启 DSH**（Host 半边重新生成），刷新页面让 Client 半边生效；然后在会话中间栏切到「变更关系图」。

## 1. 安装

二选一。

**A. 让 agent 装（推荐）**

在任意一个 Harness 会话里说：

```
把 <本仓库路径>/dsh-review-graph 这个本地 bundle 装到当前 profile
```

如果该会话有 `plugin_manager` 工具（Creator mode 才有），它会调用
`install_bundle` 并把 `target` 指向上面的绝对路径。装完请把返回结果里的
`application` 和 `warnings` 字段贴出来——只有 `application: applied` 才算生效。

**B. 命令行装**

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add <本仓库路径>/dsh-review-graph
```

装完需要让 bundle 生效：`plugin_manager` 的 `set_bundle`，
或在设置 → 插件里把 **Review Graph** 打开。

---

## 2. 验收清单

代码能做的自检已经全绿——**358 项**（342 项无需 Electron），含**用假 React 真跑一遍渲染**：

```sh
npm test                       # 全部自检（下面前五个）
```

Host 半边的注册契约不要靠猜：直接从**已安装的 app.asar 里**导入真实的
`@deepseek-ai/dsh-tools`（只有 Electron 运行时能读 asar），用它自己的
`assertSupportedJsonSchema` / 校验器跑一遍 `index.js` 的 definition：

```sh
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/verify-host-tool.mjs    # 16 checks, all pass

node test/git-scopes.mjs       # 48 checks：真实临时仓库上的 scope / 差异提交 / 只读断言
node test/host-routes.mjs      # 76 checks：五个路由的 Request 级验证（含 AI 流程，用假模型）
node test/diff-parse.mjs       # 20 checks：真实 git 输出上的 unified diff 解析
node test/flow-parse.mjs       # 37 checks：prompt/对话上下文/记录预算、校验、缓存键（无模型）
```

这些自检与核对抓到并修掉了 8 个真实缺陷（第 9 条只是顺带清理）：

1. **格式函数挂在字符串翻译函数上**。`COPY` 里混了字符串和小格式化函数，而 locale 服务只按
   key 解析字符串，于是改动超过一轮时 `t.scopeTurn(...)` 会抛。现在格式化函数作为属性挂在
   翻译函数上。
2. **`remote` 和 `tab.actions` 根本不在 `conversation.view` 的 props 里**，所以列目录和点击跳转
   都会静默失效。现在从 `ctx` 显式注入（`remote` / `sessions` / `sidebarRight`），并且
   `openResource` 失败会在图下方显示原因而不是无声失败。
3. **核心模块用了 Node 的 `extname`/`dirname`/`join`**，浏览器内联版没有这些，
   `lib/analyze.mjs` CLI 也会直接崩。现在核心自带这几个纯函数，**零运行时导入**。
4. **`review_graph` 工具从未注册进模型**（2026-10-07 安装时发现）。`ctx.tools.register`
   收的是**线级 raw JSON Schema**，不是作者 DSL：它先要求 `output.render` 是函数（缺了就
   `TypeError`），再 `assertSupportedJsonSchema(output.schema)`，而 `{ type: 'json' }`
   只是 `defineTool` 才会编译掉的 DSL 类型。旧代码三处都踩了，异常又正好被自己的
   `try/catch` 吞掉，于是只有一句 warn，工具静默消失。现在 definition 手写成
   `parameters: { type: 'object', properties: {...} }` + `output: { schema: {}, render }`；
   不 import `defineTool` 是有意的——profile 安装的 bundle 从自己的目录解析，
   那里没有 `@deepseek-ai/*`。
5. **`ctx.remote` 的返回值被当成 payload**（2026-10-07 对着已装产品核对时发现）。每次
   unary Remote 调用返回的是 `RemoteResult` 信封 `{ ok: true, value } | { ok: false, error }`，
   而旧代码直接读 `listing.entries` / `result.text` → 永远 `undefined` → 列目录为空、
   一个文件都读不到，整张图静默变成空态。现在统一走 `unwrapRemote()`；**列不出根目录时
   会抛错并在图下方显示原因**，只有单个子目录失败才跳过。
6. **会话事件日志的字段名全错**。`sessions.list` 的行没有 `events`，客户端的 `Session`
   上那个 `events` 是 `SessionEventStream` 对象（不是数组）。真正的日志是
   `sessions.binding(id).eventSource`：`getSnapshot()` 返回缓存快照，条目形如
   `{ event, type }`，`subscribe` 只通知不回调。旧代码三级兜底全部落空 →
   `collectTurns` 恒返回 `[]` → 「0 个改动文件」。现在从 eventSource 投影
   `workspace/changes`，并按 `seq`/`turn` 保持数组身份，避免助手流的每个 token 帧
   都触发一次全工作区重扫。
7. **`remote.workspaceFiles` 没在 `inject` 里声明**（2026-10-07 实机报 `分析失败: cannot get
   property "remote.workspaceFiles" without inject`）。`remote` 是 traceable 服务：它把
   `.workspaceFiles` 转发成对**自己 ctx** 的 `ctx['remote.workspaceFiles']` 点号读取，而
   cordis 只有在该名字出现在 `inject` 里、被解析并绑到 ctx 上之后才认得它；只声明载体
   `remote` 不够。三个已装包（`dsh-api-workspace-files`、`dsh-client-ui-sidebar-files`、
   `dsh-client-ui-sidebar-documentpreview`）都是 `['remote', 'remote.workspaceFiles']` 这么写的。
   自检里加了派生检查：扫源码里所有 `ctx.<a>...`，根段必须在 inject 里，点号命名空间必须
   逐个命中——把 inject 改回旧值，该项立刻 FAIL。
8. **非源码变更被整体吞掉**（2026-10-07 实测：改 `.gitignore` 后图是空的）。文件集合原来
   只含"点开头目录被跳过 + 有源码扩展名"的文件，而 `analyze()` 把不在集合里的变更路径算作
   `unresolved`，于是 `changedCount` 为 0，界面走空状态分支**且不显示任何原因**。现在
   `withChanged()` 把变更集并进文件集合（Host 两条路径 + 客户端本地路径都改了），
   空状态也会说明是"这个来源没有改动"还是"N 个文件不在可分析集合里"，并列出 `warnings`。
10. **AI 路由读不到 `llm` + 没模型就直接 400**（2026-10-07 实机报 `cannot get property "llm"
    without inject`）。两处：`inject(['llm'], cb)` 里我用了外层 ctx 去访问 `ctx.llm`（服务只能从
    声明它的 ctx 读），以及会话日志没有 `model/selection`（它只记录"改过选择"）时我直接拒绝生成。
    现在：AI 路由跑在声明了 `llm` 的 ctx 上；Host 从 `ctx.llm.listModels(provider)` 读目录给出
    默认 pair；客户端给出模型下拉（默认会话模型 → 目录第一项），只在目录为空时才拒绝并说明原因。
9. 顺带删掉死代码：`conversation.view` 的 props 里没有 `tab`，`tab.actions.openResource`
   那条分支永远不会走。跳转只走 `ctx.sidebarRight.openResource`。

但**下面的契约已经逐条对着已装产品核过**（asar 里的 client bundle + 契约目录），
降级为"实机复看"；只有视图真的渲染出来、主题是否舒服，仍然只有浏览器能确认。

| # | 要确认的事 | 怎么看 | 失败时 |
|---|---|---|---|
| 1 | 页签出现在会话头部 | 打开一个会话，头部应有「变更关系图」 | 看控制台有没有 `slot entry crashed in 'conversation.view'`；该 slot 的注册项只有 `id`(必填) / `order` / `label`，多写的键会被静默丢掉 |
| 2 | 视图能读到会话工作目录 | 视图不是一直停在「正在分析…」 | 路径是 `sessions.list` 快照的 `byId[id].cwd`（列表行确实带 `cwd`）；`binding.session` 上**没有** `cwd`，`useSession` 也不是 cwd 来源，这两级只是兜底 |
| 3 | 变异清单能读到 | 侧栏统计不是「0 个改动文件」 | 事件日志在 `sessions.binding(id).eventSource`（`MutableSessionEventSource`，快照条目形如 `{ event, type }`），**不是** `session.events`，也不是列表行的 `events`；窗口只保留最近一页，很老的轮次可能不在里面 |
| 4 | 工作区列举/读文件可用 | 状态会从「读取文件 n/m」走到出图 | 两件事：`ctx.remote` 的每次调用返回 `{ ok, value }` 信封（**不是** payload 本身），且 `inject` 里必须有 `'remote.workspaceFiles'` 这个点号名字，否则报 `cannot get property "remote.workspaceFiles" without inject`；工作目录列不出来会在图下方显示原因，而不是静默出空图 |
| 5 | **点击节点能跳转并高亮行** | 点图上的方块，右侧栏应打开该文件并滚到对应行 | `conversation.view` 的 props 里**没有** `tab`，所以只有 `ctx.sidebarRight.openResource(address, { params: { line } })` 一条路；它要求屏上会话已挂载，否则抛 `sidebarRight: no session surface is mounted`，已显示在图下方 |
| 6 | 主题一致 | 换明暗主题，图不刺眼 | 目前只用了 `--dsw-alias-*` token，如需微调改这些即可 |

我自己能验的部分，实际结果：

- 分析器在真实结构上识别出 `parser → store → editor` 一个三文件关联簇 + `format.ts` 一个独立文件 ✔
- **2000 文件合成仓库压测：92ms，`node_modules` 正确跳过，无截断** ✔
- `index.js` 的 `buildGraph` 用一个 mock `ctx.fs` 跑通，`node_modules` 被跳过、边正确 ✔
- `client.js` 通过 `window.__ModuleLoader__.load` 真实注册进 `conversation.view` ✔
- Client 半边逐条对着**已装产品**核过契约：`conversation.view` 的注册项与 props、
  `slots.inject/register`、`locale.register/bind`、`remote.workspaceFiles.*`（含信封）、
  `sessions.binding().eventSource`、`sidebarRight.openResource`，以及 boot roster 要求
  （`dsh.client` + `exports["./client"]` + 工厂 id 等于包名）✔
- 组件体在假 React 下能渲染出元素树，hooks 无异常，effect 清理安全 ✔
- `layoutGraph` 在空图 / 全孤立 / 自环 / 悬空边 / `component: null` 五种退化输入下都不崩 ✔

---

## 3. git 变更来源怎么来的

git 来源**不能**在浏览器里算：某个 commit / 分支对比的文件内容根本不在工作区里。所以这类
图由 Host 侧算完，再作为一种**同构的图文档**返回给同一个渲染路径。

| 需要什么 | 用哪个产品能力 |
|---|---|
| 跑 git | `ctx.subprocess`（`dsh-base` 挂了 `dsh-subprocess-local`）。照抄 `dsh-workspace-changes` 的姿态：scrubbed env + `GIT_CONFIG_COUNT=0` / `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0` / `LC_ALL=C`、30s 超时、8 MiB 有界输出、2s 终止宽限 |
| 把数据送到界面 | `ctx.connection.fetch.register({ path, methods:['GET'], requestBody:'buffered', fetch })` —— 注释写明 *the connection service supplies authentication*（明文 `curl` 会被 401 挡住） |
| 仓库/分支清单 + 基准分支的差异提交 | `GET /api/review-graph.state?cwd=<绝对路径>&base=<分支>`（不带 `base` 时 Host 自己挑主干并回传） |
| 某个来源的图 | `GET /api/review-graph.graph?cwd=<绝对路径>&scope=<spec>` |
| 变更来源的文件清单 | `GET /api/review-graph.files?cwd=&scope=` |
| 单个文件的 diff | `GET /api/review-graph.diff?cwd=&scope=&path=&old=`（`old` 只在 rename 时需要） |
| 业务流程：计划 / 生成 | `GET /api/review-graph.flow?cwd=&scope=`（零 token）/ `POST` 同名（要 `provider`+`model`，可带 `rebuild`） |
| 历史版本的文件内容 | `git ls-tree -r -z --name-only <rev>` + `git show <rev>:<path>`（并发 8，受 `MAX_FILES` / `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` 约束） |

**谁能进图**：变更文件**永远**进图，非源码文件（`.gitignore`、`.github/**`、`package.json`、
锁文件…）也一样；但只有源码文件参与 import / 符号引用分析。所以文件集合 = 扫到的源码
∪ 本次变更的文件（`withChanged()`）。这条是踩出来的：早先只索引源码，改一个只含
`.gitignore` 的变更集会被解析成 0 个改动文件，界面直接给空状态、连原因都不说。变更集
大于 `maxFiles` 时只提升前 `maxFiles` 个，其余仍计入 `change.unresolved` 并在图下方显示。
非源码变更只作为节点，**不读取其内容**（`.env` 这类文件不会把内容带进图文档）。

commit 菜单 = `git log <base>..HEAD`（差异提交，两点式）；`commit:<sha>` 的图 = 该提交对**第一父
提交**的 diff（根提交走 `diff-tree --root`）；`branch:<ref>` 的图 = `merge-base(ref, HEAD)` 对
HEAD 的三点式 diff。**菜单是两点式、图是三点式**，这不是笔误——GitHub PR 也是这么分的：
commit 列表按可达性，diff 按合并基点。

scope spec：`unstaged` / `staged` / `uncommitted` / `commit:<sha>` / `branch:<ref>`。
`cwd` 会被 `realpath` 规范化后交给 git（macOS 上 `/tmp`、`/var` 是符号链接，git 会回规范路径，
不规范化就会差一个 `private/` 前缀）；长度/形状也做校验，`commit:` 只接受 4–40 位十六进制，
`branch:` 必须在真实分支清单里命中——**不给 git 传任何以 `-` 开头的可疑参数**。

**只读保证**：只有 `rev-parse` / `for-each-ref` / `log` / `merge-base` / `ls-tree` / `show` /
`diff` / `diff-tree` / `ls-files`，没有 `add`、`stash`、`checkout`，并且 `GIT_OPTIONAL_LOCKS=0`
让 `diff` 连 `.git/index` 都不刷新——自检里有一条断言 `.git/index` 在所有 scope 解析前后**字节
不变**。

### 与产品自带审查面板的关系

产品**有**一个"所有变更文件"的审查面板（`dsh-resource://changes-review/session/<sid>/<seq>/<turn>`）：
标题「第 N 轮改动」，带「选择要查看的文件」下拉、单栏/左右对比切换、自动换行、在侧边栏打开整个文件。
但它绑死**轮次快照**（`dsh-workspace-changes` 每轮记录的 git 快照），没有 ref/base/head 参数，
所以 unstaged / staged / uncommitted / commit / 分支对比这五档用不了它——那些来源的审查面板是本插件
提供的（同样是"整个来源"的形态：左栏文件清单 + 右栏 diff + 上一个/下一个）。

### 业务流程（AI）怎么来的

| 环节 | 用什么 |
|---|---|
| 调模型 | `ctx.llm.stream({ provider, model, messages, system, maxTokens, purpose, signal })`。默认**用当前会话的模型**（客户端从会话日志的 `model/selection` 事件读出）；会话日志只记录"改过选择"，所以没读到时会退回 Host 从适配器目录读出的**第一个可用 pair**，并在卡片上给出**模型下拉**（`ctx.llm.listModels(provider)`）——选模型就是选账单 |
| 注入上下文 | AI 路由注册在**声明了 `llm` 的那个 ctx** 上（`ctx.inject(['connection','subprocess','llm'], flowCtx => …)`）：cordis 的服务只能从声明它的 ctx 上读，用外层 ctx 访问会报 `cannot get property "llm" without inject` |
| 不污染会话 | 消息是**请求级**输入（user 角色、无 id/source），不进会话日志 |
| 路由 | `GET /api/review-graph.flow`（**计划，零 token**：文件数、prompt 字节、候选 provider、缓存命中）+ `POST`（生成） |
| 上下文 | 结构与变更片段：文件清单/状态/行数 + 导出符号 + 引用边 + 每文件 diff 片段（总 **40KB**、单文件 6KB 上限，超出标 `(clipped)`）；上限写在生成前的卡片上 |
| **对话上下文** | 同一个会话日志里再取一份**意图摘要**：最近 3 条用户消息 + 2 条助手回复 +（有则）产品自己的 `compaction/summary`，总量上限 4000 字符。git 只说明**改了什么**，对话才说明**为什么改**；prompt 里明确"命名业务意图用对话，判断实际改动以代码为准，两者冲突以代码为准" |
| 输出校验 | `lib/flow.mjs` 把模型答案当**不可信输入**：剥代码围栏、逐字段校验、缺 label 的节点导致该侧作废→整张流程丢弃、悬空边丢弃、`confidence` 只认 `low` |
| 缓存 | 键 = `(repoRoot, scope, HEAD, hash(对话摘要))`；最多留 8 份；`HEAD`/来源/对话变了自动失效，`rebuild: true` 显式重跑 |
| 失败 | 终止 chunk 的 `reason.failure.code`（如 `MISSING_CREDENTIAL`）原样回报；模型没给可用 JSON 时报出具体 problems |

**记入对话（可选，默认关）**：AI 卡片上的勾选框打开后，这次生成会往会话里追加**一问一答**——
因为"点击生成"在语义上就是你在对话里发了条消息、模型回了流程图：

1. `user/message` = **你的请求**（「生成流程图解释所有变更的代码」）+ 一行出处（来源 / 模型 / 用量 / 时间 / 是否复用缓存）；
   **不含代码片段、prompt 正文、回答正文**——追加的消息代表"用户说过的话"，不能把材料塞进去；
2. `assistant/message` = **模型给出的流程**，以自然语言渲染（摘要 + 每块业务的改动前/改动后步骤与流转 + 风险），
   不是原始 JSON。

两者都用产品自己的 append 形式：`session.append(type, data, { surfaceOp: 'append' })`（surface 事件必须带
`surfaceOp`）。代价必须说清：它们会进入后续每轮的模型上下文（多花 token），所以默认关。

**prompt 正文与模型原始回答不进对话**，改由面板承担：生成后卡片上有「查看发送内容与原始回答」，
展开是只读的 System prompt / 发给模型的用户消息 / 模型原始回答（各 24 000 字符上限并标 `(clipped)`）。
调试信息留在面板里，读它不花 token，也不冒充你说过的话。

缓存命中时同样可以补记（不必再花一次生成的钱）；没给 `sessionId`、会话不在本 Host、或组合里没有
`sessions` 服务时，返回 `recorded: false` 加原因，不会让生成失败。

**三层缓存，卡片上会说明这次答案从哪来**：

| 层 | 活多久 | 说明 |
|---|---|---|
| 客户端 `flowClientCache` | 一个页面生命周期 | 切页签不丢；刷新即失效 |
| Host 内存（按 key） | 一个 Host 进程 | 刷新页面不丢；**重启 App 即失效** |
| **Host 落盘** | 跨重启 | `<DSH_HOME>/storages/review-graph-flows/<hash>.json`，只留最近 20 份（0o600） |

落盘这层是补上"重启后状态重置、也不知道缓存到底有没有生效"两个问题的：生成返回前**先写盘**（写失败
只记日志、绝不影响生成），计划接口会回 `diskCached`，卡片上直接写清是「缓存命中，不花 token」、
「Host 上有这次变更的缓存（重启后也能恢复）」，还是「Host 上没有缓存，生成会花 token；本次页面已生成，
切页签不丢、刷新要重新加载」。

**页面切换不丢结果**：中间列的视图在切换时会被**卸载**（`conversation.view` 没有 `keepMounted`），
组件状态随之消失——请求并没有被取消，只是结果没人接。所以生成结果写在插件级的
`flowClientCache`（同一页面生命周期内跨视图切换保留）；刷新页面后则靠 Host 侧缓存：计划里带回
`cached` 时自动补一次（命中缓存**不花 token**），面板恢复成刚才的样子。

**大小和推理强度是用户的选择，不是插件的限制**：卡片上两个下拉——

* **上下文**：精简 12KB / 标准 40KB（默认）/ 全量 120KB，外加 `perFileBytes`（默认 6KB，上限 32KB）；
  Host 只做**边界**（4KB–256KB / 1KB–32KB），不改你要的大小。**不要**为了迁就某个模型的思考习惯
  去砍所有人的输入——那会拉低其他模型的答案质量（我一度这么做过，已回滚）。
* **推理强度**：只有 provider **公布了档位**时才出现下拉（`ctx.llm.resolveModel` 的
  `reasoningEfforts`），否则只有「默认（跟随 provider）」。**绝不猜**：传一个适配器不认的档位会让
  整次调用校验失败，比不做更糟。未选择时不传该字段。
* 某个模型把预算全花在推理上时（`finish=max-tokens` + `reasoning chunks` 吃满），下一次计划会带回
  `lastFailure`，卡片直接建议**换模型**并说明"加大预算没用，它会全部用掉"。

**输出预算是为推理留的**：`maxOutputTokens` 默认 **40 000**（卡片上会显示）。第一次实机失败就是
8 000 全被推理吃掉（`finish=max-tokens`、8 000 个 reasoning chunk、可见文本 0），所以现在：
可见文本优先；**推理文本只在它能解析出 JSON 时**才被采用（`fromReasoning: true`）；两者都不行时，
报错会直接说明"整个输出预算都花在推理上，请提高上限或换一个不把思考写在输出里的模型"，
并带上 finish 原因、chunk 计数、答案长度与开头 300 字。system prompt 也加硬了：必须以 `{` 开头、
不得叙述推理过程。

**审查面板自带轻量语法高亮**：产品的文件预览确实会高亮代码，但它活在那个包自己的 bundle 里，
而插件不得 import 任何 Harness Client 包（模块加载器也会拒绝未在模块表里的请求），也没有"把代码
交给产品渲染"的 slot。所以面板自己着色：一个零依赖的扫描器（注释 / 字符串 / 数字 / 关键字 / 类型），
覆盖 ts·js·py·go·rs·java·kt·swift·c·cpp·cs·php·sql·sh·json·yaml·toml·html·xml·css·scss，
并跨行携带块注释与模板字符串状态。它不是语法分析（会有误判），但**对每一行都保持"token 拼起来
等于原行"这条不变量**——自检里对 8 种语言 × 14 行语料逐一验证，另有跨行状态用例。
要说"复用产品高亮"，唯一可行的是面板上的「在文件中打开」跳转到产品的预览。

**模型没给出 JSON 时**：终止原因、text/reasoning/其它 chunk 计数、答案长度与开头 300 字都会写进
报错。若模型只流了推理文本（reasoning-delta）就拿它当答案；若一个字都没流，报错会直接说
`the model streamed no text at all` 并带上 `finish=…`——这才是可诊断的失败。

**为什么必须点击才跑**：`ctx.llm` 按 token 计费，而"把变更翻译成业务流程"是推理型任务，
不像索引那样可以随手重算。所以：默认零请求、生成前公示预算、结果按变更集缓存、
重建要显式点。没有挂模型适配器时，这一档只显示一句说明，不影响其它功能。

### agent 也能用

`review_graph` 工具多了 `scope` 参数（同样的 spec 字符串），所以 agent 可以直接问
「这个分支相对 main 改了什么、影响面多大」，而不需要打开界面：

```
review_graph { "scope": "branch:main" }
review_graph { "scope": "unstaged" }
```

`subprocess` 与 `connection` 是**可选**依赖（`ctx.inject([...], cb)`）：没有它们的组合里插件
照常挂载，`review_graph` 仍能对工作区出图，只是 git 来源与视图路由不可用。

---

## 4. 审查面板（右侧栏）

节点的默认动作是**审查**，实现方式照产品自己的契约（`dsh-client-ui-sidebar-right`）：

| 环节 | 用什么 |
|---|---|
| 声明资源类型 | `ctx.sidebarRightTabs.register({ id, kind, patterns: ['dsh-resource://review-graph/session/**'], canOpen, title })`——`priority` 不写即默认 `extension`（产品外类型最高档） |
| 面板正文 | `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <类型 id>, locale }, Pane))` |
| 读到地址与参数 | 正文通过框架注入的 `useTabInfo().tab` 取 `contentId` 与 `navigation.params`（组件不吃 props） |
| 改动文件清单 | `GET /api/review-graph.files?cwd=&scope=` → 只解析 scope，不读 blob（面板左栏用它） |
| diff 数据 | `GET /api/review-graph.diff?cwd=&scope=&path=&old=` → Host 跑 `git diff`（rename 时**新旧路径都要进 pathspec**，否则 git 配不出 rename、会渲染成纯新增）→ `lib/diff.mjs` 解析成带行号的 hunk |
| 轮次来源 | 直接开产品自己的 `dsh-resource://changes-review/session/<sid>/<seq>/<turn>` + `{ params: { index } }`——那一档产品已有审查面板，不重复造 |
| 样式 | 只用自己的 DOM + `--dsw-alias-*` token（产品明令插件不得 import 任何 Harness Client 包，也不存在现成的 hunk 渲染服务） |

`params` 里带 `scope`/`cwd`/`old`/`line`/`label`，因为点击与面板挂载不同时、面板还可能比视图活得久。
若审查地址打不开（类型没注册、或当前没有屏上会话），会**回退**到原来的纯文本预览。

---

## 5. 结构

```
dsh-review-graph/
├── package.json          # dsh.bundle / dsh.client 声明
├── cordis.patch.yml      # Host 侧 insert 行
├── index.js              # Host：review_graph 工具（给 agent 用）
├── client.js             # Client：中间列视图 + 图渲染 + 跳转
├── lib/analyze-core.mjs  # 纯分析核心（无依赖、可单测）
├── lib/analyze.mjs       # CLI 包装，可脱离 Harness 跑
├── lib/git.mjs           # git 来源：scope 解析 + 仅解析器（注入 exec，可单测）
├── lib/diff.mjs          # unified diff → 带新旧行号的 hunk（供审查面板渲染）
├── lib/flow.mjs          # AI 业务流程：prompt 组装 + 不可信输出的严格校验 + 缓存键
├── build-client.mjs      # 把核心内联进 client.js（单一实现来源）
├── icon.svg
├── locale/{en,zh}.json
├── test/selftest.mjs          # 161 项：分析器 + Host/Client 半边的假运行时
├── test/git-scopes.mjs        # 48 项：真实临时仓库上的 scope / 差异提交 / 只读断言
├── test/host-routes.mjs       # 70 项：五个路由的 Request 级验证（含 diff 与 AI 流程，用假模型）
├── test/diff-parse.mjs        # 20 项：真实 git 输出上的 diff 解析
├── test/flow-parse.mjs        # 33 项：prompt/对话上下文/调试记录的预算与校验（无模型）
└── test/verify-host-tool.mjs  # 15 项：Host 注册契约（需 Electron 运行时读 asar）
```

### 数据从哪来

| 需要什么 | 用哪个产品能力 |
|---|---|
| 本轮改了哪些文件 | `GET /api/changes.summary?sessionId=&seq=`（`workspaceChanges` 插件提供） |
| 哪几轮改过文件 | `sessions.binding(id).eventSource` 快照里 `type === 'workspace/changes'` 的条目（`{ event }` 包装），取 `event.seq` / `event.data.turn` |
| 会话工作目录 | `sessions.list` 快照的 `byId[id].cwd` |
| 列目录 / 读文件 | `ctx.remote.workspaceFiles.list(sessionId, path, signal)` / `.read(sessionId, path, {}, signal)`，都要拆 `{ ok, value }` 信封；`inject` 必须同时写 `'remote'` 和 `'remote.workspaceFiles'` |
| 打开文件到行 | `ctx.sidebarRight.openResource('dsh-resource://file/session/<sid>/<path>', { params: { line } })` |
| 全部分析 | 在浏览器里跑 `lib/analyze-core.mjs`（已被内联） |

分析器是纯函数 + 正则启发式，不依赖 tree-sitter，也不装任何东西。这是刻意的：
**引擎层已经有更好的开源实现，本插件补的是"侧栏/中间列可点图 + 跳到行"这一段。**

### 改分析逻辑

只改 `lib/analyze-core.mjs`，然后：

```sh
node build-client.mjs && node test/selftest.mjs
```

会把核心重新内联进 `client.js`（客户端模块是 plain script，不能用 ESM import，
所以靠内联保证只有一份实现）。

### 脱离 Harness 单独跑分析器

```sh
node lib/analyze.mjs /path/to/repo src/a.ts src/b.ts     # 或从 stdin 读 JSON 数组
```

---

## 6. 已知限制（v1 有意为之）

- **组件状态槽的分片粒度**：组件在假 React 下渲染通过，但真实 React 的并发渲染、Suspense、
  以及 slot 崩溃监督（`slot entry crashed`）只在实机验证。
- **文件级 + export 级，不是精确调用图**。JS/TS 的 import 是准的；跨文件"引用"靠
  "文件里出现了另一个文件导出的符号名"判定，会有误报（同名符号）和漏报（动态调用）。
  要精确的 caller/callee，接 `code-review-graph`（MIT、tree-sitter、30 个 MCP 工具）或
  LSP call hierarchy，把结果喂给同一套渲染。
- **流程图是符号清单，不是真正的业务流程时序**。AI 生成流程图应该是下一步：让模型从
  `review_graph` 工具返回的符号索引里**挑节点**（而不是自己编行号），再补上时序信息。
- **首次索引是客户端逐目录列举 + 逐文件读取**，几千文件的仓库会慢。后续可换成 Host 侧
  一次算完 + 一条 HTTP 路由返回。
- **AI 那一档是整个请求-响应**：不做逐 token 流式渲染（也没有中途取消按钮），一次生成等到底；
  一次生成覆盖这次变更的全部业务块（比每张图调一次便宜），结果按变更集缓存 8 份。
- **AI 结论需要人核**：它由模型推理得出，prompt 里已要求"材料不支持就别写、拿不准标 low"，
  校验器也只保证结构合法，不保证业务判断正确——节点上的文件/行锚点就是给你核对用的。
- **模型来自会话日志**：读不到 `model/selection` 时生成会被拒绝并说明原因（不会替你猜一个模型）。
- **非源码变更只作为节点**，不参与引用分析（没有 import 可言），也不读取其内容；所以
  `.gitignore` 会出现在图里、可以点开，但它永远是一个孤立节点。
- **git 来源一次只取一个 scope**，commit 菜单上限 200 个差异提交；仓库里只有一个分支时
  「已提交」退回当前分支最近 50 个提交（没有可比基准）。合并提交按**第一父提交**对比；
  分支对比是三点式，且**不包含工作区未提交内容**（要那个就选「未提交」）。
- **历史 revision 的 blob 是逐文件 `git show` 读的**（并发 8）。几千文件的仓库会慢；正解是
  单进程 `git cat-file --batch`，但它用字节长度分帧，而收集到的输出是解码后的文本，
  非 ASCII 内容会错位，所以 v1 选了慢但正确的那条。
- **事件窗口只有最近一页**：`eventSource` 快照带 `hasMore`，本插件没回翻 `prepend` 分页，
  所以很老的轮次可能不在「本轮/全部」范围里。要全历史得接分页。
- 新增/删除的文件不在索引里，会计入 `change.unresolved` 并给出提示。

## 开发与自检

```bash
npm test        # 342 项：分析器、git 来源、Host 路由、diff 解析、AI 文档校验
npm run build   # 重新生成 prism.bundle.js 与 client.js（两者都已提交，构建必须幂等）
npm run verify  # 构建 + 自检，prepublishOnly 用的就是它
```

另有一项需要 Electron 的 Host 契约自检（16 项，共 358 项），它在应用外跑：

```bash
ELECTRON_RUN_AS_NODE=1 "<DSH 可执行文件>" test/verify-host-tool.mjs
```

自检不联网、不调用模型：AI 那部分用假 adapter 驱动 `ctx.llm.stream`，渲染那部分用假 React
真跑一遍组件树（因此"组件里读了不存在的名字"这类错误会在自检里失败，而不是在浏览器里变成
空白页签——这一条是被三次真实空白页签换来的）。

`node build-vendor.mjs --fetch` 会联网刷新 `vendor/prism/`；默认**不联网**，因为已提交的文件
就是事实来源，离线也必须能构建。

## 许可证

MIT，见 [LICENSE](LICENSE)（© 2026 huaxiaolong）。

内联的 Prism.js 同样是 MIT，版本、来源与再生成方式见 [vendor/prism/NOTICE.md](vendor/prism/NOTICE.md)；
`prism.bundle.js` 是它的拼接产物，头部带有归属说明。

**Prism 是构建期依赖，不入库**：使用 `node build-vendor.mjs` 从 jsDelivr 抓取 Prism 1.29.0 的
297 个组件到 `vendor/prism/`（该目录被忽略），再拼接成 `prism.bundle.js`。入库的只有三件小文件
——`LICENSE`、`NOTICE.md`、`manifest.json`——因为 MIT 要求它们随产物分发；**构建产物
`prism.bundle.js` 入库并随 npm 包发布**，这样 `dsh plugin add <git 地址>` 不需要任何构建步骤。

```bash
npm run build            # 缺 vendor/ 时先抓取，再生成 bundle 与 client.js
npm run prefetch         # 显式刷新到 manifest 里记录的 Prism 版本
npm run verify:offline   # 完全不联网：CI 若无网络，先缓存 vendor/ 再用这条
```

**为什么拼接而不是依赖**：DSH 的 Client 插件不得 import 产品包，且 npm 依赖不在模块表里——
在插件里 `require('prismjs')` 会直接抛错，所以只能由构建把它拼成一个文件、由插件自己加载。

## 贡献

欢迎 issue 与 PR。开工前请跑一次 `npm run verify`——自检失败时我基本不会看原因，直接要求先绿。
提交信息请写清**为什么**（"修了什么"代码里看得见）。
