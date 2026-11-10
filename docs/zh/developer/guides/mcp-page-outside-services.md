---
title: 页面外 MCP 服务接入指南
order: 140
---

# 页面外 MCP 服务接入指南

本文说明如何将 **页面外的 MCP 服务** 接入 EO2Weave 当前平台，包括：

- Figma Remote MCP
- OpenPencil 本地 MCP
- 其他不在当前页面上下文内、需要通过浏览器插件代理访问的 MCP 服务

## 1. 先明确边界

当前平台里有两类能力来源，必须分开理解：

### 1.1 WebMCP

WebMCP 指的是 **当前页面上下文直接暴露** 的 MCP 能力。

特点：

- 工具发现和调用发生在页面上下文内
- 适合接入当前网站自身暴露的工具能力
- 不用于连接独立运行的远端或本地 MCP Server

### 1.2 页面外的 MCP 服务

页面外的 MCP 服务指：**不属于当前页面上下文**、独立存在的 MCP Server。

例如：

- Figma Remote MCP：`https://mcp.figma.com/mcp`
- OpenPencil 本地 MCP（桌面应用启动的本地服务）
- 其他本地/远端独立 MCP Server

特点：

- 页面不能直接依赖浏览器内 `fetch` 去访问它们
- 必须通过 **浏览器插件 bridge** 代理请求
- 这样才能统一处理：
  - 跨域限制
  - 本地地址访问
  - header / token 透传
  - SSE / streamable HTTP 流式响应

---

## 2. 当前平台的接入原则

当前实现已经确定为：

> **所有页面外的 MCP 服务，都必须通过浏览器插件 bridge 代理访问。**

也就是说：

- Web 页面 **不直接 fetch** 页面外 MCP 服务
- `mcp-client.service.ts` 统一通过 `window.__agentWeb` bridge 发起请求
- 插件负责真正的网络访问与流式转发

这条原则对以下场景都适用：

- Figma Remote
- OpenPencil 本地 MCP
- 未来新增的页面外 MCP 服务

---

## 3. 相关代码位置

> 以下路径均相对仓库根目录 `eo2weave/`。

### Web 侧

- `web/services/mcp-client.service.ts`
  - 正式 MCP client
  - 负责 initialize / tools/list / tools/call / task 轮询
  - 只走插件 bridge，不走页面直连

- `web/mcp/`
  - MCP 领域模块目录
  - 与页面外 MCP 服务接入直接相关的关键文件包括：
    - `web/mcp/mcp-manager.ts`
    - `web/mcp/preset-providers.ts`
    - `web/mcp/mcp-types.ts`

- `web/components/mcp/MCPSettings.tsx`
  - MCP 设置 UI
  - 添加 server、编辑配置、连接、查看状态

### 浏览器插件侧

- `browser-extension/entrypoints/injected.content.ts`
  - 页面内注入 `window.__agentWeb`
  - 暴露：
    - `mcpNetworkFetch(...)`（SDK 字节流接口）
    - `mcpProxyFetch(...)`（旧网页兼容）
    - `mcpProxyFetchStream(...)`

- `browser-extension/entrypoints/content.ts`
  - 页面与 background 之间的 relay

- `browser-extension/entrypoints/background.ts`
  - 真正执行网络请求
  - 处理：
    - `mcp_network_v2`
    - `mcp_proxy_fetch`
    - `mcp_proxy_fetch_stream`

---

## 4. 请求链路

页面外 MCP 服务的调用链路如下：

```text
MCPSettings / MCPManager / MCPClientService
  -> SDK Transport -> window.__agentWeb.mcpNetworkFetch(...)
  -> injected.content.ts
  -> content.ts relay
  -> background.ts
  -> 目标 MCP Server
```

### 4.1 streamable HTTP

适用于标准 Streamable HTTP，支持 JSON 与 POST SSE 响应。

当前实现中：

- `server.transport === 'streamable_http'`
- SDK Streamable HTTP Transport 通过 `mcpNetworkFetch(...)` 走插件代理

### 4.2 SSE

适用于传统 GET 建流、独立 POST 发送请求的 SSE 服务。

当前实现中：

- `server.transport === 'legacy_sse'`
- SDK SSE Transport 通过 `mcpNetworkFetch(...)` 走插件字节流代理
- 插件先发送 `response_start`，再传递 Base64 字节块、正常结束或错误；取消会中止上游 fetch

---

## 5. 为什么必须走插件 bridge

### 5.1 跨域问题

以 OpenPencil 为例：

- MCP HTTP 服务由桌面应用自动拉起
- 服务通常暴露在本地地址，如 `127.0.0.1:7601`
- 浏览器页面直接访问这类本地地址时，容易遇到 CORS / 本地环回访问限制

这也是 OpenPencil 在浏览器里不适合页面直接接入的核心原因。

### 5.2 页面能力边界

即使远端服务本身可访问，也不应让页面自己承担：

- token 管理
- SSE 细节兼容
- 本地地址探测
- timeout / streaming 转发

这些都更适合由插件 bridge 统一处理。

### 5.3 平台架构一致性

统一走 bridge 后：

- WebMCP 与页面外 MCP 服务的边界清晰
- Web 侧 MCP client 实现更稳定
- 插件可以独立演进代理能力
- 新服务接入步骤更可复用

---

## 6. Figma Remote 接入步骤

Figma Remote 是当前最直接可接入的页面外 MCP 服务。

### 6.1 服务信息

- Endpoint: `https://mcp.figma.com/mcp`
- 推荐 transport: `streamable_http`
- 需要 Figma token / 官方 MCP 授权能力

### 6.2 平台接入方式

当前项目已经提供 Figma preset：

- 配置位置：`web/mcp/preset-providers.ts`
- UI 入口：`web/components/mcp/MCPSettings.tsx`

### 6.3 配置步骤

1. 打开 MCP Settings
2. 使用 **Quick add Figma preset**，或手动新增 server
3. 填写：
   - ID：`figma`
   - URL：`https://mcp.figma.com/mcp`
   - Transport：`streamable_http`
   - Auth Token：填写 Figma token
4. 保存配置
5. 点击 Connect
6. 通过插件 bridge 完成 initialize / tools/list

### 6.4 常见失败原因

- 浏览器插件不存在
- 插件版本过旧，不支持页面外 MCP 代理
- Figma token 缺失、过期或权限不足
- transport 误设为 `legacy_sse`
- 网络访问失败或请求超时

当前 `MCPSettings.tsx` 已针对 Figma 补充了更友好的连接失败提示。

---

## 7. Mail MCP 接入步骤

Mail MCP 是 EO2Weave 自研的 streamable_http MCP server，提供邮件起草 / 发送 / 草稿管理能力。典型场景：agent 帮用户写邮件 → 起草 → 二次确认 → 发送。

### 7.1 服务信息

- 内部共享 endpoint：`https://mail-mcp.jianguoyun.net.cn/mcp`
- 共享 setup 页：`https://mail-mcp.jianguoyun.net.cn/setup`
- 本地开发 endpoint：`http://127.0.0.1:3011/mcp`
- 本地 setup 页：`http://127.0.0.1:3011/setup`
- 部署命令：`pnpm -C mcp-servers/mail-mcp-server dev` / `build` / `start`
- 推荐 transport：`streamable_http`

提供 9 个工具：`get_mail_account_status` / `get_mail_setup_link` / `verify_smtp_connection` / `draft_email` / `get_email_draft` / `list_email_drafts` / `delete_email_draft` / `send_email_draft` / `send_email`。

### 7.2 多用户模式（推荐）

共享部署下，每位用户用自己的 **Personal Mail Token** 隔离邮箱：

1. 用户访问 `/setup` → 点 "生成 token" → 保存 token
2. 用户在 setup 页填 SMTP 凭据（host / port / user / 授权码）→ 验证 → 保存
3. 用户在 EO2Weave MCP Settings 加 Mail MCP preset → 把同一个 token 粘到 Auth Token
4. Agent 调 `tools/call` → server 拿 token 识别该用户 → 用该用户的 SMTP 凭据发送

**关键点**：EO2Weave 端**不存** SMTP 凭据，只存 Personal Mail Token（由 mail-mcp 自己生成）。server 端用 token 查账号配置并解密 SMTP 密码。EO2Weave 前端代码无需感知 SMTP 细节。

> 旧版「单账号模式」通过环境变量 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 等配置，目前保留为向后兼容，不推荐用于多用户共享部署。

### 7.3 平台接入方式

当前项目已经提供 Mail preset：

- 配置位置：`web/mcp/preset-providers.ts`（id: `mail`，category: `communication`，icon: `mail`）
- UI 入口：`web/components/mcp/MCPSettings.tsx`

### 7.4 配置步骤

1. 打开 MCP Settings
2. 使用 **Quick add Mail MCP preset**，或手动新增 server
3. 填写：
   - ID：`mail`
   - URL：`https://mail-mcp.jianguoyun.net.cn/mcp`（或本地 `http://127.0.0.1:3011/mcp`）
   - Transport：`streamable_http`
   - Auth Token：粘贴你在 `/setup` 页生成的 Personal Mail Token
4. 保存配置
5. 点击 Connect（走浏览器插件 bridge）

### 7.5 常见失败原因

- 浏览器插件不存在 / 版本过旧，不支持页面外 MCP 代理
- Mail MCP server 未启动，或内网 firewall 拦截
- Personal Mail Token 没生成 / 复制错位 / 在 setup 页未保存 SMTP 凭据
- SMTP 凭据错误（QQ Mail 必须用 SMTP **授权码**，不是登录密码；host: `smtp.qq.com`，port: `465` SSL 或 `587` STARTTLS）
- transport 误设为 `legacy_sse`

### 7.6 当前已自动化 vs 未自动化

**已自动化**：

- preset provider（`id: mail`）
- setup 引导文案（覆盖 `/setup` 页流程 + QQ Mail 配置示例）
- 默认 URL 指向内网共享部署，文档同时给出本地开发备选

**未自动化（后续可演进）**：

- 没有 "前往 setup 页" 快捷按钮（用户需自己记 `/setup` URL）
- 发送前**未**弹确认对话框（`send_email` / `send_email_draft` 直接执行，依赖 agent 自觉）
- `mail-mcp` 已为未来确认对话框预留 `draft_response.preview.text/html` 字段（draft 工具返回 JSON 中），但 EO2Weave 当前未消费

---

## 8. OpenPencil 接入步骤

OpenPencil 更适合作为 **本地桌面应用 + 插件代理** 场景接入。

### 7.1 已知前提

- OpenPencil 是开源 AI 原生设计编辑器
- 可打开 `.fig` 文件
- 内置 MCP Server（90+ 工具）
- 支持 `stdio` 和 `HTTP`
- HTTP MCP 由桌面应用自动 spawn 启动
- 本地通过 WebSocket / 本地端口与运行中的应用协作
- 会自动生成：
  - `OPENPENCIL_MCP_AUTH_TOKEN`
  - `OPENPENCIL_MCP_CORS_ORIGIN`

### 7.2 为什么不建议页面直连

虽然 OpenPencil 会提供本地 HTTP MCP 接口，但在浏览器里直接连接本地地址会遇到：

- CORS
- 浏览器对本地地址访问限制
- 桌面应用运行态依赖

所以当前平台下，推荐方案仍然是：

> **由浏览器插件 bridge 代理访问 OpenPencil 本地 MCP。**

### 7.3 推荐接入形态

在 MCP Settings 中新增一个 user server，例如：

- `id`: `openpencil`
- `name`: `OpenPencil MCP`
- `url`: 由 OpenPencil 实际暴露的本地 HTTP MCP 地址决定
- `transport`: 以 OpenPencil HTTP MCP 实际协议为准
  - 若是标准 SSE，则填 `legacy_sse`
  - 若是标准 streamable HTTP，则填 `streamable_http`
- `token`: 使用 OpenPencil 提供的 auth token

### 7.4 接入前检查项

1. OpenPencil 桌面应用已启动
2. 内置 MCP 服务已随应用启动
3. 已确认实际 MCP URL
4. 已拿到 auth token
5. 通过插件 bridge 发起连接，而不是页面直连

### 7.5 当前未自动化的部分

当前项目里 **还没有** OpenPencil preset，因此需要手动配置：

- preset provider
- setup 引导文案
- 更细的错误提示

如果后续要产品化接入，可以参考 Figma 的做法新增 OpenPencil preset。

---

## 9. 新增一个页面外 MCP 服务的标准步骤

以后接入新的页面外 MCP 服务时，建议按下面流程：

### 第 1 步：确认协议形态

先确认服务提供的是：

- `streamable_http`
- `legacy_sse`
- 还是仅 `stdio`

> 注意：当前 Web 平台主要支持 HTTP 形态；纯 `stdio` 服务不能由网页直接接入，必须先有桌面端或代理层转换。

### 第 2 步：确认鉴权方式

明确以下信息：

- 是否需要 Bearer token
- token 从哪里获取
- 是否需要额外 header
- 是否有 session header（如 `mcp-session-id`）

### 第 3 步：确认是否属于页面外服务

只要服务不属于当前页面上下文，就按页面外 MCP 服务处理：

- 不放进 WebMCP 概念里
- 不让页面直接 `fetch`
- 统一走插件 bridge

### 第 4 步：在 UI 中新增配置入口

至少要保证用户可以配置：

- id
- name
- url
- transport
- token
- timeout

如需降低使用门槛，再补：

- preset provider
- setup checklist
- 常见错误提示

### 第 5 步：验证完整链路

至少验证：

1. `server/discover`，或旧版 `initialize`
2. `tools/list`
3. 选一个真实工具执行 `tools/call`
4. 如支持 task，再验证：
   - `tasks/get`
   - `tasks/result`（2025 Tasks）；新版结果随 `tasks/get` 返回
   - `tasks/cancel`，以及新版 `tasks/update`（标准 JSON-RPC 方法，使用 MCP 端点）

---

## 10. 当前实现状态

当前仓库里的实际状态是：

### 已完成

- `mcp-client.service.ts` 正式 client 统一走插件 bridge
- SDK 使用 `mcpNetworkFetch` 字节流；保留 `mcpProxyFetch` 与 `mcpProxyFetchStream` 兼容旧网页
- 支持 timeout 透传
- 支持从响应头捕获 `mcp-session-id`
- 支持 task 轮询也走 bridge
- MCP Settings 已集成 Figma preset、Mail MCP preset
- Figma / Mail MCP 连接失败提示已增强
- 文档覆盖：Figma Remote、Mail MCP（含内网共享 + 本地开发两种部署形态）

### 未完成

- OpenPencil preset
- OpenPencil 专属 setup 文案
- OpenPencil 专属错误提示
- Mail MCP 的 send 前确认对话框（draft_response.preview 字段待消费）
- 页面外 MCP 服务的更完整产品化文档/测试矩阵

---

## 11. 建议的后续演进

如果后续继续做产品化，建议按优先级推进：

### P1

- 新增 OpenPencil preset
- 给 OpenPencil 增加 setup checklist
- 补一份页面外 MCP 服务的测试清单

### P2

- 在 MCP Settings 中区分：
  - WebMCP
  - 页面外 MCP 服务
- 让用户更清楚当前配置的是哪一类能力

### P3

- 为常见服务提供更标准的 preset catalog
- 统一错误分类：
  - 插件不可用
  - token 错误
  - timeout
  - network
  - transport 不匹配

---

## 12. 一句话结论

在当前平台架构下：

- **Figma Remote**：可以直接作为页面外 MCP 服务接入，推荐优先支持
- **Mail MCP**：EO2Weave 自研远程 MCP，已通过 preset 接入，依赖用户在 `/setup` 页自助配置 Personal Mail Token + SMTP 凭据
- **OpenPencil MCP**：技术上可接，但应通过浏览器插件 bridge 代理，不应由页面直连本地地址
- **通用原则**：所有页面外的 MCP 服务，都通过 `web/services/mcp-client.service.ts` + 浏览器插件 bridge 接入

## 官方 SDK 与后台 Tasks

网页端使用固定版本 `@modelcontextprotocol/client@2.4.0` 和
`@modelcontextprotocol/ext-tasks@0.2.2`。每个服务连接有独立的 SDK Client、Transport
和 Tasks Session。协议默认自动协商；高级设置中的「旧版 initialize」可以跳过新版探测。
认证、网络错误会直接显示，不会被当作协议不兼容。

配置迁移规则：旧 `sse` 表示 POST 响应流，统一迁移为 `streamable_http`；真正的 GET
建流使用新选项 `legacy_sse`。导入也执行相同转换，导出包含规范化后的传输值与
`protocolMode`。普通连接不复用数据库中的旧会话 ID。现有 Bearer Token 配置继续有效，
本轮不增加 OAuth 登录流程、Node 后端、浏览器 stdio 客户端或 Native Host 协议迁移。

扩展新增 `mcp_network_v2` 流接口，依次传递响应状态与头、Base64 字节块、结束或错误。
取消流、页面断开均会中止上游 fetch。网络响应头超时、每次协议请求超时、本地有限等待
分别管理，持续流没有固定 5 分钟寿命。旧桥接仍保留；连接旧扩展时普通请求仍可使用，
但后台 Tasks、传统 SSE 与可靠取消需要升级扩展，设置页会显示提示。

### Agent 调用与查询

`call_tool` 增加 MCP 专用参数 `execution_mode: "background" | "wait"`。
有项目、会话归属时默认后台模式；同步工具仍直接返回原结果。标准 Tasks 返回
`submitted: true`、`completed: false`、`local_task_id`、`remote_task_id` 和状态，Agent
可以继续其他工作。没有归属的内部调用等待最终结果。WebMCP 显式后台模式会返回不支持。

Agent 收到后台任务编号后应告知用户任务待完成，继续独立工作或结束当前轮次，不主动连续
调用 `wait/status/result`。仅在用户明确要求等待、获取结果，或点击卡片中的「发送给 AI」后使用
等待与结果读取。这个默认行为通过系统提示、工具说明及提交回执共同约束，不是权限拦截。
`mcp_tasks.wait` 的外层工具超时至少比本地等待期限多 5 秒，避免 30 秒等待与统一超时竞争。

`mcp_tasks` 只操作当前项目已知任务：

| action | 行为 |
| --- | --- |
| `list` | 列表，可用 `conversation_id` 筛选 |
| `status` | 读取远端状态和本地观察状态 |
| `result` | 返回原始最终结果；未取得结果时返回当前状态 |
| `wait` | 默认本地等待 10 秒，最多 30 秒 |
| `cancel` | Agent 授权后请求远端取消 |
| `resume` | Agent 授权后恢复已有任务的观察 |

恢复、取消、查询均不会重新执行原工具。已移除私有 REST Tasks 路径、向工具参数注入
`arguments.task`、从文本 JSON 识别任务 ID 的逻辑。用户工具参数中原本的 `task` 字段
保持普通参数的含义。

### 持久化、刷新与多标签页

SQLite v19 新增 `mcp_tasks` 和 `mcp_task_inputs`。创建请求发送前先保存提交记录；
任务引用保存并由页面级管理器接管后，Agent 停止不会取消任务。交接前已知任务 ID 时
尽力取消。创建响应丢失时标记「提交结果不明」，禁止自动重放。网络观察失败不等于远端
失败；瞬态错误按 2、5、10、30 秒退避，认证和协议错误暂停并提示处理。

Web Locks 按端点、协议代次、远端任务编号协调单一观察者；同源其他标签页通过
BroadcastChannel 接收状态和输入请求。页面关闭后停止本地观察；扩展后台和 Service
Worker 不负责长期轮询。重新打开后仅恢复已有引用。恢复要求服务仍启用、端点及认证
身份一致、服务端任务仍存在。旧版 HTTP Tasks 还要求原会话 ID 与能力快照有效。
会话过期或任务不存在时只显示原因，不创建替代任务。

任务记录不复制 Token 或模型 API Key。最终结果保留文本、图片、资源块和结构化内容。
序列化超过 256,000 字符的结果复用资产 I/O，保存在所属项目的 `assets/mcp-tasks`
目录；删除原会话后仍可查看，不依赖原会话资产目录。

### 临时任务卡片、输入与手动继续

原会话输入框上方按需显示 MCP 任务卡片，没有任务时不占空间。运行中紧凑显示服务、
工具、状态和耗时；轮询只更新状态，不新增消息、不抢焦点。结果就绪后可展开查看，或
点击「发送给 AI」。任务区域可通过「稍后」收起为一行，任务完成时不会强行展开。
多任务默认显示两项，其余按需展开。暂停、恢复、取消和输入交互在卡片详情中处理。
原左下角任务入口和任务弹框已移除。

只为新任务及上线时尚未结束的任务启用卡片。已完成的旧记录不弹出；历史仍保存在数据库，
可由 `mcp_tasks` 按项目查询。查看结果无需调用模型。失败、取消及提交结果不明可点击
「知道了」隐藏提示，不删除记录或重新提交。

完成通知通过持久化标记去重，不自动启动 Agent。用户点击「发送给 AI」后，向原会话
发送引用本地任务编号的普通用户消息，不改动输入草稿或历史工具调用。消息保存成功后卡片
消失，不等待 AI 回答结束；原会话忙碌时按钮显示「加入待发送队列」。入队后由现有队列
展示，若队列撤销、清空或刷新丢失则恢复卡片，不自动重投。已发送及已关闭状态跨刷新保留。
原会话不存在、结果尚未保存或发送失败时保留卡片并说明原因。

标准 SDK 请求与 Tasks 输入共用处理器，并绑定原项目、会话：

- 表单按 Schema 校验，可接受、拒绝或取消。密码类字段仅在内存保留，刷新后重新询问。
- URL 请求展示来源与链接，必须由用户手动打开，不自动访问或代填凭据。
- sampling 展示待发送消息、实际配置模型和输出预算，明确确认后才调用模型。仅发送
  服务端提供的内容，不自动附带会话或工作区。无法表示的内容、无法强制执行的工具选择、
  无法保证输出预算的 Provider 会明确拒绝。返回的工具调用只是数据，不自动执行。
- roots 默认返回 `{ roots: [] }`，不暴露本地路径。

原有自定义二进制上传继续作为独立业务流程保留。

### 验证

```sh
cd web
pnpm test:run mcp
pnpm test:run agent
pnpm test:run components
pnpm test:run store sqlite services
pnpm typecheck
MCP_LONG_TASK=1 pnpm test:run mcp/__tests__/long-task.integration.test.ts
```

最后一条执行真实经过 305 秒的 SDK/桥接协议夹具，不启动浏览器；它不能代替真实扩展与
服务端的联调。可选 `playwright.mcp.config.ts` 测试覆盖实际 MV3 扩展、两代 Tasks、
刷新恢复、多标签页输入和取消，仅在需要浏览器验证时运行。该夹具的任务仓库使用浏览器
本地适配，SQLite 的 schema 与 DDL 单独验证。`MCP_E2E_EXTENSION` 指定实际加载的
扩展构建目录，`MCP_LONG_TASK=1` 启用长任务场景。普通扩展构建产物仍为
`browser-extension/dist/chrome-mv3`，开发产物目录独立。
