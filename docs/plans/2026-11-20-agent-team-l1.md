# L1 Agent Team — 设计与实施计划

> **状态**：草案 v1 · 2026-11-20
> **范围**：单会话、单用户、浏览器内。不含常驻执行、不含跨人委派。
> **前置讨论**：本方案的结论来自 2026-11-20 的四路只读代码审阅 + 若干次实测（证据见附录 A）。

---

## 0. 一页摘要

| 项 | 内容 |
|---|---|
| **做什么** | 把已经能跑的「脚本化多 agent」产品化成「**临时可组建的团队**」：一句话派活、成员各带职能与能力边界、产物走黑板、人只做开头和收尾 |
| **不做什么** | 常驻（关页继续跑）、跨人/跨机、工作流白板、成员自由对话 |
| **七个核心决策** | D1 子代理默认匿名 · D2 成员分三层 · D3 persona 与 capability 分离 · D4 绑定由模型决策 · D5 黑板独立命名空间 · D6 编排唯一入口 · D7 任务独立实体 |
| **工期** | P0–P5 约 4 周（含 2 周观察期），P6 观测/UI 可选 |
| **最大风险** | 去掉隐式人格可能降低子代理产出质量 → 用 P0 基线 + A/B 兜住 |
| **需拍板** | Q1 记忆写策略 · Q2 临时成员是否进项目名册 · Q3 团队任务是否允许跨会话 |

### 一句话定位

**L1 = 把「分工」做成产品。** L2 才是把「在岗」做成产品（需要把 AgentLoop 的宿主从浏览器 tab 搬走，属另一个立项）。

---

## 0.5 执行清单（TODO）· 唯一进度源

> 规则：**完成一项就勾掉，并把结果/证据写在行尾**。范围或决策变更必须同步改本节与对应章节，避免两处不一致。

### P0 基线

- [x] **P0-1** 静态确认 persona 注入链路 → 结果：`sources.ts:73-77` → `prompt-builder.ts:22-60`，链路上**没有** `isSubagent` 判断，子代理必中
- [x] **P0-2** 量出 token 成本 → 结果：**≈15.4k token/子代理**（persona 11.6k + 今日日志 3.8k），5 人扇出 ≈ **76.8k token 纯开销**（实测见 §7 P0）
- [ ] **P0-3** 抓一次真实请求体（live dump，需一次页面刷新）：flag 默认关，抓完即移除
- [ ] **P0-4** 记录基线产出质量：同一任务跑 3 次 explorer，留作 P1 对照

### P1 匿名化 + 可选身份（2–3 天）

- [x] **P1-1** `resolveAgent` 区分「缺省 → default」与「显式 `null` → 无 persona」 → 结果：`sources.ts:18-23`；opt-in，现有调用方传 `undefined`，行为零变化
- [x] **P1-2** 名册 / `today-log` 两个 source 对子代理不注入 → 结果：名册加 `isSubagent` 早退（`sources.ts:69-75`）；`today-log` 由 P1-1 的 `null` 路径顺带覆盖；5 个单测 + typecheck 通过
- [x] **P1-3** `currentAgentId` 改 per-execution（`ensureLoop` 里 `actorId ?? null`） → 结果：`runtime.ts:1203-1207`；父人格不再泄露，`null` = 匿名
- [x] **P1-4** `SpawnSubagentInput` 加 `as` / `role` → 结果：`tool-types.ts:160-170`；`subagent.tool.ts` schema + executor、`agent-runner.ts` normalize 均已透传
- [x] **P1-5** `role` 拼进子代理 system prompt（与 4 个预设后缀并存） → 结果：`role-prompts.ts` 新增 `SubagentRoleOptions`，顺序 base → Assigned role → type 后缀；`actorId` 不进 prompt（身份走 context source）
- [x] **P1-6** `optionsKey` 纳入 `as` / `role`（属 replay 身份，漏了会误命中缓存） → 结果：`agent-runner.ts:128-136`
- [x] **P1-7** 名册带 `role` → **顺延到 P2**（`role` 字段需 P2-1 的 `AgentMeta.role`）；本周只保留「名册不对子代理注入」
- [x] **P1-8** opt-out 的 source 直接不发布（而非发 `{}` 空快照） → 结果：发现于 A/B 探针（匿名子代理报「`agent-persona` 快照为空」）；改为 `return undefined`，`sources.ts:77-100`
- [x] **P1-验收** A1 / A2 通过 + 与 P0-4 对照无退化 → 结果：匿名 17,119 vs actor 35,200 input tokens；匿名说不含姓名/组织/同事表，actor 原文引用了这三类

### P2 能力边界（3–4 天）

- [x] **P2-1** `AgentMeta` 扩 `role / capabilities / memoryPolicy`（`meta.json` 直接透传，向后兼容） → 结果：`agent-manager.ts:24-42`；`model` 未加（见 P2-4）
- [x] **P2-2** `readonly` 强制 plan（照抄 `explorer` 正例） → 结果：`runtime.ts` `mode = explorer || readonly ? 'plan' : ...`
- [x] **P2-3** 能力**分类**过滤，schema 级 + 执行级双保险 → 结果：新增 `tools/tool-capabilities.ts`（5 类：read/write/shell/external/orchestrate）；`withCapabilityClasses` 代理只过滤 `getToolDefinitionsForMode`，`beforeToolCall` 再做一次拒绝
- [x] **P2-4** `model` 覆盖 provider → **推迟**（需 provider 工厂 + 凭据解析，与安全无关，单独一刀）
- [x] **P2-5** 冲突 fail-closed + 可读错误 → 结果：`readonly × 非 read 类` → INVALID_INPUT；未知类名抛错；`as` 指向不存在的 actor → INVALID_INPUT（不降级成“无人格”）；meta.json 写坏 → 降为 `['read']` + warn
- [x] **P2-6** inline 能力（临时成员）与常驻成员走同一条判定 → 结果：`SpawnSubagentInput.capabilities` 与 `meta.capabilities` 在 `createTask` 取**交集**
- [x] **P2-7** （并入 P1-7）名册带 role 并改写为 spawn 提示 → 结果：`default → spawn_subagent(as: default)`
- [x] **P2-验收** A3 部分通过（详见下方“A3 实测”）→ 结果：schema 层生效（worker 看不到 write/bash/run_code），**但拓展出一个真漏洞已修**
- [x] **P2-8** 上下文源与能力边界对齐（bash 手册 / skills / external-tools）→ 结果：新增 `canUseTool()` 门禁 + `ToolContext.capabilityClasses`；3 个新单测证明“关着的门不给手册”

**A3 实测（2026-11-20，刷新后，`worker` + `capabilities:{classes:['read']}`）**

| 断言 | 结果 |
|---|---|
| 模型看不到 `write` | ✅ 自述“工具列表里没有 write”，共 32 个工具 |
| 模型看不到 `bash` / `run_code` | ✅ |
| 它能写完一个文件吗 | ❌ **能**——用 `run_python` 在 `/mnt/我的坚果云/p2-probe.txt` 写了个文件（进了 OPFS 待审区）|

**根因**：`run_python` 在我第一版分类里没映射 → 落到默认值 `read`。而它在 `agent-mode.ts` 里本来就标成 `category:'read'`，plan 模式只靠**提示词**说“只能写 /mnt_assets”——不可执行。

**这直接推翻了一个旧假设**：`explorer` / `readonly` 的“只读”对 `run_python` / `bash` 一直只是君子协定。真正执行住它们的只有 capability classes。

**已修**：
1. `run_python` 归 `shell`（连同 `bash`/`exec`/`run_code`/`processes`/`canvas_run`）
2. 未知工具默认从 `read` 改为 **`write`**（fail-closed）；`read` 改为显式白名单（21 个）
3. 补讕：`install_skill` / `db_query` / `rollback_checkpoint` / `sync-to-disk` / `canvas_*` 均归 `write`
4. 回归测试 18 例（含 `run_python=shell`、未知工具→`write`），全绿；typecheck exit 0

**副作用清理**：探针写的 `我的坚果云/p2-probe.txt` 已删除（它只存在 OPFS pending，未落盘）。

**P2 落地要点**

- **按分类不按工具名单**（巍巍拍板）：`read / write / shell / external / orchestrate`。名单式白名单会失败开放（新工具只是“没写进去”），分类式可以失败关闭，**前提是默认值选对**，默认 `read` = 失败打开，默认 `write` 才叫失败关闭（已改成后者）。
- **两层拦截**：代理只改 `getToolDefinitionsForMode`（模型看不见），`beforeToolCall` 再拒一次（幻觉或注入都拦）。只做后者会被提示词绕过，只做前者会被伪造调用绕过。
- **交集而非覆盖**：成员 `meta.capabilities` 与调用方 `capabilities` 取交，任一方向都不能单方面扩大。
- **踩过的坑（真教训）**：在 `createTask` 里插一句无条件 `await`（即使没有 `as`），会让 spawn 可见性晚一个微任务 → 9 个队列/超时测试集体挂。修法是无 actor 时保持同步路径。**公共方法上的每多一个 `await` 都是一次时序变更**。
- **第二个坑（本轮真实发生）**：`canUseTool()` 一开始写在了 `createRuntimeContextSources` **外面**，体内却用工厂闭包里的 `input()` → 运行时 `ReferenceError`，而 journal 会吞掉 collector 异常 → 症状是“skills / external-tools 源静默消失”（4 个无关测试挂）。**依赖闭包变量的 helper 必须定义在闭包内**；source 失败只表现为“没数据”，不会报错——这类静默比 crash 难查得多。

### P3 黑板 `vfs://team/`（2.5–3 天）

- [x] **P3-1** namespace + parse + `TeamBoardBackend` → `agent/team/team-paths.ts`（路径/ ACL 纯逻辑）+ `team-backend.ts`（OPFS 适配）；resolver 已接 `vfs://team/{runKey}/...`
- [x] **P3-2** ACL 三条（read 全开 / write 限 `by/{actor}/` / lead 白名单文件）→ `authorizeTeamAccess()` 接入 `resolveVfsTarget`；`TeamAccessContext.isLead = !context.isSubagent`；空路径仅 read（列目录）可用
- [x] **P3-3** `ls` / `glob` → 实测报错 `Backend has no discovery implementation` 坐实了缺口：`vfs/ls-operation.ts` 的 `resolveDiscoveryScope()` 只给 `workspace` / `assets` / `skills` / `agent` 四条路。已修：`DiscoveryScope` 联合 + 分支扩到 `team`，复用 `assets|skills` 的通用目录遍历。**实测通过**（刷新后）：列板根→`00-brief.md`+`manifest.json`；列 `by/default`→`notes.md`。注意：`ls` 在注册时就持有模块引用，**改完必须刷新**，否则旧报错会伪装成“没改对”
- [x] **P3-3b** 铸 `teamRunKey` → `conversation-agent-run.ts:536` 处 `createTeamRunKey(conversationId, runId)`，注入 lead `toolContext` + `baseToolContext`；子代理经 `taskContext = { ...deps.baseToolContext }` 自动继承同一个板，`createExecution` 又给每个执行冻结一份副本
- [x] **P3-4** 删除项目级联清理 → **无需代码**：`team/` 位于 `projectsDir/{id}/` 下，而 `deleteProject` 本就是 `projectsDir.removeEntry(id, { recursive: true })`。布局决策（D5）在这里直接兑现
- [ ] **P3-5** bash `/team` 挂载（可选）
- [x] **P3-6** 约定 + 可发现性 → `context/sources.ts` 新增 `team-board` 源（有 `teamRunKey` 才发布；lead / member / 只读三种文案）；`_ledger.jsonl` **推迟到 P4**
  - lead 看到：`00-brief.md` + `manifest.json`（只有你能写）+ `by/{actorId}/`；member 看到：全可读、只能写 `by/{自己}/`；只读执行体看到：“你不能写”
  - manifest 约定（lead 单写，模型直接 `write`）：
    ```json
    { "goal": "...", "tasks": [{ "id": "t1", "goal": "...", "assignee": "<agentId>", "status": "pending|running|done|blocked", "artifacts": ["by/x/notes.md"] }] }
    ```
- [x] **P3-验收（部分）** 实测（本会话，刷新后）：
  - 越权写被拒 → `PERMISSION_DENIED: cannot write run "probe-run" from run "1795151660134-176ib6t-1795161462713-o3w3v277"`（原因可读，且顺带证伪了 runKey 格式）
  - 读不存在的板 → `Team board not found for run "probe-run"`（**读不创建目录**的行为生效）
  - lead 写保留文件 + 写自己 `by/default/` → 均成功，`status: saved` / `pendingCount: 0` → **不进 sync pending**
  - 读回 `source: "team"`，内容一致；`git status -- team` 为空 → 不进 git
  - 刷新后产物仍在：**未实测**（板在 OPFS，理论上成立，但没真刷新过）
  - **可发现性实测**：新 run 的上下文里真的出现了 `## Team Board` 段（runKey `…-1795162074440-1ddeym84`），模型无需猜路径；跨轮 runKey 不同 → 每轮一块新板
  - 本轮真写了 `00-brief.md` + `manifest.json` 到自己的板（`…-1795162331511-ewo6oieq`），均 `status: saved`、零 pending

### P4 任务实体 + 结构化交接（4–6 天，**不新增数据库表**）

- [x] **P4-1** `manifest.json` 升级为任务实体 → `agent/team/team-manifest.ts`：`TeamTask`（id / goal / assignee / status / artifacts / handoff{expects,reads,writes}）+ `parseTeamManifest` / `serializeTeamManifest` / `emptyTeamManifest` / `upsertTeamTask` / `setTeamTaskStatus` / `tasksForActor` / `renderTeamManifest`；17 个单测
  - 失败语义：坏 JSON / 任务缺 id·goal / id 重复 → **抛错**（一张不可信的板比一张空板更危险）；未知 status → 降为 `pending` 并记入 `issues`（**绝不降成 `done`**）；新版本号 → 只警告不拒绝
- [x] **P4-2** `handoff` 结构化 → `spawn_subagent` 新增 `task_id` + `handoff{expects,reads,writes}`；`createTask` 里以 **lead 身分**读改写 manifest（状态置 `running`、写入 assignee 与 handoff）、再拿回自己的 brief；写失败不杀 spawn，但错误随之进入成员 prompt
- [x] **P4-3** 读投影 → `ensureLoop` 把 `## Your task on the team board` 拼进 `finalSystemPrompt`（ContextManager 与 AgentLoop 用同一份），成员只看得到**自己那条任务**（按 id 不按 assignee：两个匿名成员都是 `assignee: null`，按 assignee 筛会互相看到）
  - 分层：`team-manifest.ts`（纯逻辑）/ `team-board.ts`（唯一碰 OPFS 的 manifest 层，走 `resolveVfsTarget` 拿授权句柄）/ `runtime.ts`（只管拼 prompt）
  - **实测（三探针）**：t1/t2 各自只引回自己那条、都答 `OTHER TASKS: none`；worker 试图写 manifest → `PERMISSION_DENIED`
  - **实测揭出的 bug（已修）**：`resolveActorAgentId` 在 `currentAgentId` 为空时回退到 `useAgentsStore.activeAgentId`（UI 状态）再回退 `'default'` → 匿名成员实际写 `by/default/`，**和 lead 同一目录**；而提示词里我自己编了个 `by/anonymous/` → 三个名字全对不上，子代理直接拒绝写。
  - **修法（D8）**：`teamMemberSlot({actorId, taskId})` 成为**唯一**答案：有 actor → `by/{actorId}/`，匿名 → `by/{taskId}/`，都没有 → 无写区（不编名）；ACL / 提示词 / handoff 三处均调它；`resolveActorAgentId` 对子代理**不再回退 UI 状态**；`handoff.writes` 落在槽位外 → spawn 当场 `INVALID_INPUT`（`fatal`），不让成员跑到一半才发现写不了。
  - **run goal 的单一来源（补 A4 最后一环）**：goal 只在 `00-brief.md` 里，manifest 不存副本；spawn 时 `readTeamBrief()` 读一次（截断 800 字）拼进成员段落的 `Run goal (from 00-brief.md):`，位置在任务之上。以前 `manifest.goal` 恒为空 → 成员只看得到“我这条任务”，看不到“这次 run 在干什么”。
- [x] **P4-4** 按成员重跑：落到 `agent(prompt, { retry: true })` —— 只跳过该步缓存，**不置 `diverged`**，其余步骤照常命中；被跳过的旧行同时加入 `consumedPrior`，防止兜底循环把它喂给后面同 prompt 的步；`retry` **不进 `optionsKey`**（它只决定服务哪一行，不改变子代理的身份）。实测：`agent-runner.replay.test.ts` 7/7；`agent(prompt)` 不传 options 也不再报错。
- [x] ~~**P4-5** 显式 `step_id`~~ → **降级为可选**：读码坐实 `const index = stepIndex++` 在首个 `await` 之前执行（`agent-runner.ts:271`），所以**步序不会按完成顺序漂**（推翻先前 P2-3 的判断）；正确性由 prompt 文本精确比对保证，不靠 `diverged`，也不靠位置编号。
- [x] **P4-6** task 状态机 + `_ledger.jsonl` 追加 → 终态回写已接：`done`（completed）/ `blocked`（failed / timeout / queue-empty / kill）四处调用点；`artifacts` **从目录列出来**（`listTeamSlotFiles`），不采信成员“我写了什么”的宣称；ledger 每事件一行 JSON（`spawned` / `done` / `blocked`），写失败不影响 manifest
  - **真机揭出的第二个 bug（已修）**：成员在**下一轮**才结束时，板上那条永远停在 `running`、账本也没有 `done`。根因不是写失败，是终态回写读的是**实时** `deps.baseToolContext.teamRunKey` —— 轮次一切换它就没了，于是第 495 行直接 `return`，**静默不写**。修法：spawn 受理时把 runKey 钉在 task 上（`task.teamRunKey`），终态回写与提示词构建都读它。和 D8 同一族：**身份必须在做决策的那一刻定下来，不能事后从可变状态里再取一次**。
  - 顺带记下：`runKey` 是**按轮次**的，跨轮的「重跑某成员」落的是一个新板。L1 就按这个算（能读旧板/旧账本，但不是同一个 manifest）。
  - 写入顺序：manifest 先（state），ledger 后（history）—— ledger 失败只丢历史，不丢事实
- [ ] **P4-7**（可选）`subagent_tasks` 保留期清理：只做 DELETE，不做 schema 变更
- [x] **P4-验收** A4 / A6 通过 —— 四条断言各自有真机证据：
  - **A6-① 跨轮写回**（`cd80fb2c` 验证）：`b1` 在轮 A 的板上登记（`…1795184885244-19557ha3`），**跨过三次轮次边界**（新板 `…904266` / `…931058` / `…981989`），最后在旧板上写下了 `"b1": "done"` + 账本 `done`（`1795184981339`）。修复前这个写回会静默丢失。
  - **A6-② failed → blocked**：`tfail` 真失败，板上 `blocked`、账本 `blocked` 带 `error` 原文。
  - **A6-③ 同 task_id 重跑**：`b3` 同轮内 spawn 两次 → 板上**一条**、账本 `spawned×2 + done×2`；任务身份不变，执行历史全留。
  - **A6-④ artifacts 从目录取**：`tok` 写下 `by/tok/ok.md` → 板上 `artifacts: ["by/tok/ok.md"]`，与磁盘实际文件一致。
  - **A4**：成员只引回自己那条（`OTHER TASKS: none`）、能引回 `00-brief.md` 的 goal、写区文案与 ACL 一致（`by/t1/`）、越位写被拒。
  - **已知缺口（记为 L1 限制）**：`spawn_subagent` 的 schema **不暴露 `timeout_ms`**，lead 无法主动造出“确定性超时”；而“让它回空”不是可靠开关（模型会回一句括号说明）。要测超时分支目前只能从 `agent()` 侧传 `timeout_ms` 或改代码。

### P5 清理（2 天 + 2 周观察）

- [x] **P5-1** 观测频次 → **跳过**（巍巍决定先清理后观察；工具本身已从模型可见面移除，后续自然无新数据）
- [x] **P5-2** 删 `batch_spawn` → 已删：`subagent.tool.ts` 定义+执行器、注册、`enableBatchSpawn`（store 7 处）、设置页开关、i18n 四语言、`agent-mode` 分类、`policy-engine` 白名单、`RUN_CODE_BLOCKED_TOOLS`、`ORCHESTRATE_TOOLS`、tool-recommendation 元数据与过滤
- [x] **P5-3** `delegate_to` **停止写入** → 已注销工具 + 从 `ALL_PROMPT_DOCS` 移除；`delegationNote` 字段、`agent_input` 判定、`MessageBubble` 渲染全部保留
- [ ] **P5-4** 观察 2 周后删 `delegate_to` 全链（工具文件本身仍在，已无调用方）
- [x] **P5-5** 改写名册文案 → `intelligence-coordinator.ts` 改为教 `spawn_subagent(as:)` / `run_code` 里的 `agent()`
- [ ] **P5-6** 后续清理：`runtime.ts` 的 `batchSpawn`/`batchStart`/`createBatch` 已成死代码（无调用方），可随 P5-4 一并删

### P6 观测与 UI（可选，3–4 天）

- [ ] **P6-1** 任务条按 `runKey` 分组（成员 / 职能 / 产物 / 成本，可单停单重跑）
- [ ] **P6-2** 协作图用 `handoff_json` 画真实边
- [ ] **P6-3** per-member 成本汇总

### M1 内存与存储治理（2026-11-21，实战）

> 触发：巍巍报“好像有内存溢出的情况”。结论先放最前：**标签页崩的是开发构建，不是应用数据**；应用侧另有四处真浪费，已修。

- [x] **M1-1** 请求 envelope 只存摘要 → `agent/context/envelope-digest.ts`（FNV-1a 64）+ `journal.ts` 的 `ContextCommit.envelopeDigest` / `requestEnvelope()`；逐轮 meta **98,238 → 2,844 字节（35×）**，envelope 本体 **90,670 → 16 字节（5,600×）**（稳态 epoch `1795261040634-29s1t46`）。**D15**：systemPrompt 不再属于 envelope（改提示词不该让 journal 失效）
- [x] **M1-2** 存量清理（`sqlite/migrations/index.ts` v25，纯 SQL `json_remove`）→ 带 envelope 的行 **321 → 0**；全库消息文本 **313,912,737 → 283,912,737 字符（-30.0 MB）**；`context_update` 批 **42.0 MB → 11.7 MB**。数字更正：41.9MB 是那 321 行的总 payload，envelope 部分按行均值算 ≈29MB，与原提交信息写的“删掉 41.9MB”不符，已 amend 修正
- [x] **M1-3** `user_version` 永不倒退 → `readUserVersion()` 读失败返回 `null`（不是 0），恢复基线走 `bumpUserVersionFloor()` 只抬地板不赋值（**D19**）
- [x] **M1-4** hydration 只读元数据列 → `subagent.repository.ts` 新增 `findMetadataByWorkspaceId`（显式列 + `'[]' AS messages_json`），`subagent-continuation.ts` 改用（**D18**）
- [x] **M1-5** 终态成员丢弃内存 transcript → `runtime.publishTask` 在 `finished && transcriptPersisted && !stopped` 时发空数组；库是唯一副本（**含复活自 SQLite 的任务**）；**生产堆里 store 那一行从 67.7MB(48%) 消失**（**D14 后续**）
- [x] **M1-6** 子代理 transcript 递归深度封顶 → `components/agent/subagent-depth.ts`（`MAX_SUBAGENT_DEPTH = 2`），**在 row 层拒绝，不 mount panel**（**D20**）
- [x] **M1-7** 团队“一张卡”真机验收（**D11** 兑现）→ 一个 `run_code` + `Promise.all([agent(...)])`：DOM 实测 `teamCards: ["· 2 agent"]` / `memberRowsFound: 2`，一卡两行；卡头是脚本 purpose，行内 `d1 已完成`。**卡数 = `run_code` 调用数，与成员数无关**。注：P6-1 的 UI 归组因此降为可选（提示词侧已达成），仍留在 P6
- [x] **M1-8** dev 堆测量手段（不当作修复）→ `next.config.mjs` 新增 `CW_WEBPACK_DEVTOOL`：`false` / `source-map` / 不设。dev 默认 `eval-source-map` 把每个模块源码 + base64 sourcemap 常驻为可 eval 字符串：**794 MB / 954 MB 总额，生产仅 91.7 MB**。生产构建不受影响

**诊断口径（三次跑偏后的正确做法）**

| 测法 | 覆盖 ExternalString | 结论 |
|---|---|---|
| `performance.memory` | ❌ | 837→693MB 与目标无关，**不可用于这类判断** |
| `measureUserAgentSpecificMemory()` | ✅ | 本环境 25s 无响应，**不可用** |
| DevTools 堆快照 | ✅ | 唯一可用；须区分 dev / 生产两个 origin 的两份 OPFS |

**生产堆基线（`localhost:5173`，prod build）**

| 时间 | 总量 | 最大项 |
|---|---:|---|
| 改前 | 140 MB | `{agentId, conversationId, parentToolCallId…}` **67.7 MB (48%)** |
| 改后 | **91.7 MB** | `(string)` 51.6 MB (56%)、`ExternalStringData` 28.3 MB、`{version, epoch, sequence, changes}` 4.4 MB |

**已决定不做**

- **D17 撤回“工具结果懒加载”**：117MB 是**全库累计**，内存里只驻留当前会话（2.4–10MB 级）；且工具结果正文本身是模型上下文，不能从内存裁掉。分布证据：`<4KB` 25,865 条/31.6MB，`>256KB` 20 条/18.8MB
- **`meta.calls` 不动**：`MESSAGE_META_FIELDS` 白名单不含 `calls`，970 条 tool 消息 0 条含原文；而脚本内 `tools.*` 调用**不会变成对话消息**，`calls` 是唯一痕迹（`RunCodeRenderer.tsx:293` 渲染可展开详情）
- **`fs_snapshot_files` 79MB 不动**（undo/redo 属功能数据）；**`storage/init.ts:576` 的 `SELECT *` 不动**（仅手动导出路径）
- **待定 · A2**：`hydrateFromSQLite` 仍把全部任务（含 transcript）留到运行时销毁（生产堆里 `SubagentRuntimeImpl` 30MB）。不能照搬 M1-5，因为 `resume({agentId})` 要从历史续跑；可选做法是“只 hydrate 元数据 + resume 时取那一条”。未做，等拍板

**测试/类型**：`sqlite/migrations` 21 + `agent/subagent` 127 + `components/agent` 45 + `context` 28 全绿（末次复跑 126）；`pnpm exec tsc --noEmit` exit 0。本轮踩坑：`edit` 会吞换行、`vi.fn()` 内抛错必判失败、`beforeEach(() => mock.mockReset())` 是 teardown 陷阱。

### 已决定不做（不要再提出）

| 项 | 决定 | 日期 |
|---|---|---|
| 成员自由对话 / 聊天室 / 广播 | **不做**。它要求成员「持续存活」，那是 L2 的形态；且不可终止、不可复现、成本无界。需要时另立 P7「受限问答」（触发条件：dogfood 中 ≥3 次父代理转述导致信息失真或上下文爆炸的具体案例） | 2026-11-20 |
| 工作流白板整合 | 不做（节点无 agent 类型、`flow_templates` 0 行、两套执行器） | 2026-11-20 |
| 成员递归派活 | 不做（保持一级扇出） | 2026-11-20 |
| 新增 `team_tasks` 表 | **不做**。任务实体改用 `manifest.json`（见 §5.1），避免双写与 schema 迁移；既有表一个不改 | 2026-11-20 |

---

## 1. 目标与非目标

### 1.1 L1 完成态（用户视角）

1. 派活从「写 500 字人设说明」变成「@守门员 看一下这个 diff」或干脆一句「帮我审一下 PR #335」。
2. 成员的职能约束是**代码边界**（只读、工具白名单、模型选择），不是提示词里的请求。
3. 成员之间靠**产物 + 结构化交接**协作，父代理上下文**不随成员数线性膨胀**。
4. 人只做两端：开头定验收标准，结尾裁决。中间可在任务条看到谁在干什么，随时停掉重跑。
5. 跑完能回答三个问题：谁做的、产出在哪、花了多少。

### 1.2 验收线（可测，缺一不算完成）

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 子代理请求体**不含**父代理的 `USER.md` / `MEMORY.md` | 抓真实请求体对比（P0 基线） |
| A2 | 模型能**自主**把任务派给合适的既有成员 | 名册带 role 后，同一 prompt 观察选人结果 |
| A3 | 只读成员调 `write` 被**代码**拒绝 | 单测 + 手动各一次 |
| A4 | 3 成员协作时父代理上下文 token **不随成员数线性增长** | 2 成员 vs 5 成员，比较父 run 的 input token |
| A5 | 刷新页面后能复盘：成员、产物路径、成本 | 关掉 tab 重进，读 DB |
| A6 | 单个成员失败可**只重跑它** | replay 命中其余步骤 |

### 1.3 非目标（明确不做）

- 关掉浏览器后继续执行（L2）
- 成员之间直接发消息 / 广播 / 群聊
- 成员递归派活（保持一级扇出）
- 工作流白板与 team 的整合（`flow_templates` 0 行、节点无 agent 类型）
- 跨设备同步成员定义

---

## 2. 现状盘点

### 2.1 已经可用的地基（不要重做）

| 能力 | 证据 | 评价 |
|---|---|---|
| persona 五文件 + journal 增量注入，压缩不丢 | `agent/context/sources.ts:73-81`、`agent/context/journal.ts:100-110,126`、`loop/compression-history.ts:79` | 质量高 |
| `run_code` 的 `agent()` 阻塞编排 + replay | `agent/tools/run-code.tool.ts:94`、`workflow/agent-runner.ts:238-252` | 质量高，是团队脚本的地基 |
| 异步子代理 + durable completion | `sqlite-schema.sql:546`、`agent/subagent/completion-delivery.ts` | 可用 |
| 成本记账到步 | `agent/usage-cost.ts`、`workflow/sqlite-store.ts` | 可用 |
| 子代理独立 transcript + trace | `agent/subagent/transcript.ts`、`runtime.ts` `getTrace` | 可用 |
| 子代理「工作区继承、历史不继承」 | `runtime.ts:1187-1201` | 方向正确 |

### 2.2 六个阻塞缺口

| # | 缺口 | 证据 | 阻塞什么 |
|---|---|---|---|
| G1 | 子代理**隐式继承父代理整份人格** | `conversation-agent-run.ts:1099` → `runtime.ts:1195` → `agent-loop.ts:165-170` → `sources.ts:73-77` | 身份错、隐私扩散、每次多 2–4k token |
| G2 | **无法指定**子代理以谁的身份执行 | `agent-runner.ts:102-121` 无 `as`；`continuation.agentOverrideId` 捕获但无人消费（仅 `runtime.ts:260` 复制） | 临时组队没有语法 |
| G3 | 名册只有 `id + name`，无能力描述 | `sources.ts:63` | 模型无法自主选人（只能猜） |
| G4 | 成员能力**没有代码边界** | `AgentMeta` 仅 4 字段（`opfs/agent/agent-manager.ts:26-30`）；`tool-policy.ts` 全程不读 agentId | 分工只是话术 |
| G5 | 没有任务实体，也没有共享产物区 | `subagent_tasks` 主键即 `agent_id`（`sqlite-schema.sql:94-124`）；`vfs` 命名空间只有 workspace/agents/assets/skills/external（`vfs-resolver.ts:53`） | 「交接」无处安放；跨会话无法排队 |
| G6 | 编排入口分裂 | `run_code` 沙箱已 blocked `spawn/batch`（`services/tool-invocation.ts:13`），但 `batch_spawn` 仍注册（默认关闭，`settings.store.ts:1016`、`tool-registry.ts:407`）；`delegate_to` 单向不可回传 | 模型在三套语义间摇摆 |

### 2.3 两个「看起来能跑、其实名不副实」的东西

| 功能 | 真实语义 | 结论 |
|---|---|---|
| `delegate_to` | `transient: true`（`conversation-agent-run.ts:2509`）→ 不写会话绑定，只影响那一轮；无回传；子代理不可调用 | 保留价值低，建议 P5 移除（先停写、后删读） |
| `batch_spawn` | 默认关闭的实验特性 + 被 `run_code` 排除 | 与「编排入口唯一化」冲突，建议 P5 真删 |

---

## 3. 关键设计决策

### D1 子代理默认匿名：不注入父代理 persona

**结论**：子代理默认**没有**任何人格；只有显式传入 actor 时才注入该成员的人格。

**实现（刻意选了最小改动路径）**：
1. `context/sources.ts` `resolveAgent()`：区分「字段缺省 → default」与「显式 `null` → 无 persona」。
2. `agents` 名册 source 与 `today-log` source：`if (toolContext.isSubagent) return {}`（`isSubagent` 已存在于 ToolContext）。
3. `runtime.ts` `ensureLoop`：`taskContext.currentAgentId = task.actorId ?? null`。

**否决的备选**：给子代理传 `AgentLoop` 的 `contextSources` 白名单（`agent-loop.ts:97` 支持）。否决理由：要改 loop 装配、影响面更大，且白名单会漏项（新增 source 默认被继承）。

**影响面**：`sources.ts`（2 处判断）、`runtime.ts`（1 行赋值）。**注意**：`resolveAgent` 的语义变更必须配单测，否则它会在别处「返回 null」导致 persona 静默消失。

---

### D2 成员分三层，L1 只做前两层

| | ① 匿名执行 | ② 临时成员（本次 run） | ③ 常驻成员 |
|---|---|---|---|
| 定义处 | 无 | 调用点 inline：`role` + 能力 | `agents/{id}/` 目录 |
| 存储 | 不落盘 | 不落盘（仅执行记录） | OPFS + `meta.json` |
| 生命周期 | 一次调用 | 一次 run / 一个脚本 | 跨 run、跨天 |
| 可被 @ / delegate | 否 | 否 | 是 |
| 记忆 | 无 | 无 | 有 |
| L1 是否做 | ✅ | ✅ | ⏸（需要时再升级） |

**理由**：L1 的价值是「分工」，分工只需要「角色声明 + 能力边界」。常驻成员的真实成本是每次都多付 2–4k token 的人格注入，且引入并发写记忆的冲突。

**保留的升级路径**：一次成功的临时配置可以「提升为成员」——把 inline `role` 落成 `IDENTITY.md`。反向路径（先建人再派活）摩擦太大。

---

### D3 persona 与 capability 必须分离

「persona」现在装了三样性质完全不同的东西：

| 组成 | 内容 | 并发安全 | 该不该跟着子代理 | 实现位置 |
|---|---|---|---|---|
| 身份叙说 | SOUL / IDENTITY | ✅ 只读 | 要（显式 actor 时） | prompt 注入 |
| 记忆 | MEMORY / 日记 / USER | ❌ 并发写冲突 | 只读 + 写入走提议 | prompt 注入 + OPFS |
| 能力 | 模型 / 工具 / 只读 | ✅ 静态 | 要，且**不能靠文本** | capability，代码强制 |

**结论**：`role=守门员，请勿修改代码` 是话术；`readonly: true` 才是边界。

---

### D4 绑定是「模型的决策」，不是「用户的语法」

**结论**：不要求用户写清楚派给谁。默认由模型根据名册自主决定；用户只在「必须由某人做」时用 `@`。

| 路径 | 用户写什么 | 依赖 |
|---|---|---|
| L0 自动（默认） | 只写目标与验收标准 | 名册带 `role` + `spawn(as)` |
| L1 半显式 | `@gatekeeper 看一下` | 已有（`@` 决定该轮主 agent，子代理继承其身份） |
| L2 显式 | UI 下拉（`AgentDropdown` 已有） | 已有 |

**配套两条**：
- **绑错不致命**：同一批工具、可重跑、replay 只重跑分歧步。
- **可观测可纠正**：任务条显示「以 X 身份执行」，可一键换人重跑。

**分工原则**：**用户写「什么算完成」，模型写「谁去做」。**

---

### D5 黑板用独立命名空间 `vfs://team/`，不进工作区

**否决方案**：`{rootName}/.team/`。四条理由：进 git、触发 sync-to-disk 审批噪音、被 `search`/`ls` 扫到、语义错（运行时状态不该住在代码目录）。

**采用方案**：

```
{projectDir}/                 ← OPFS 项目根
  agents/{id}/                ← 人格（现有）
  team/{runKey}/              ← 新增，与 agents 平级
    00-brief.md               ← lead 写
    manifest.json             ← 索引（唯一真相）
    _ledger.jsonl             ← 追加式账本
    by/{memberId}/**          ← 成员私有可写区
```

- 不在任何 workspace root 下 → 不进 git、不进 sync、不被项目 ls 扫到。
- 生命周期随项目 → 删项目一并清理。

**ACL（可穷举三条）**：

| 动作 | 规则 |
|---|---|
| read | 本 run 内全开（成员须读 brief / manifest / 兄弟产物） |
| write | 仅 `by/{自己的 actorId}/**`；`00-brief.md` / `manifest.json` / `_ledger.jsonl` 仅 lead |
| list | 允许列 run 根；glob 仅限自己区 |
| delete | 同 write；`default` 保留全权（沿用现有超管语义，但记审计） |

**读投影**（与 ACL 同等重要）：成员只读 manifest 里 `reads` 声明的东西，不做目录全扫。ACL 管「能不能写」，投影管「会不会爆上下文」。

---

### D6 编排入口唯一：`run_code` + `agent()`

**结论**：`run_code` 的 `agent()` 是唯一编排入口。`batch_spawn` 删除；`delegate_to` 在 P5 移除。

**理由**：`batch_spawn` 的能力被 `agent()` + `Promise.all` 完全覆盖（且后者能分支、循环、replay）；`delegate_to` 与 `@` 重叠且名不副实。

**顺带修一个真实提示词 bug**：名册现在对**每个** agent（含不能 delegate 的子代理）都写 `delegate_to target_agent_id: X`（`sources.ts:63`），等于教模型用一个它没有的工具。P5 必须同时改写这段文案。

---

### D7 任务独立成实体

`subagent_tasks` 是**执行记录**（一次执行一行，带 queue/messages），不该承担「任务」语义。新增 `team_tasks` 表达**意图与契约**：目标、验收、归属、产物、状态。一次 task 可能对应多次 execution（重试）。

---

### D8 成员写槽位只有一个答案，且永不来自 UI 状态

写作用域由 `teamMemberSlot({ actorId, taskId })` 单独裁决：有 actor → `by/{actorId}/`；匿名 → `by/{taskId}/`；两者都没有 → **无写区**（不编造名字）。

依据（真机探针揭出）：修之前 ACL 用 `resolveActorAgentId()` 的兜底链 `currentAgentId → useAgentsStore.activeAgentId → 'default'`，于是1️⃣匿名成员写进了 **lead 的 `by/default/`**（“谁写的”不可答，抹掉 `by/{actor}/` 的意义）；2️⃣提示词里另编了一个 `by/anonymous/`；3️⃣lead 写的 `handoff.writes` 又是第三个名字。三个答案，子代理当场拒绝写。

两条铁律：
- **执行身份只来自本次执行**。`activeAgentId` 是用户开着哪个 tab，与 PR #349 修的 `activeAgentMode` 是同一个错。
- **契约不可执行就在 spawn 时失败**。`handoff.writes` 落在槽位外 → `INVALID_INPUT`（`fatal`），而不是让成员跑到一半才发现写不了。

---

## 4. 目标架构

```
                  ┌─────────────── 用户：目标 + 验收标准 ───────────────┐
                  ▼                                                     │
   ┌──────────────────────── lead（主对话，唯一编排者）─────────────────┐ │
   │  读名册（id + role）→ 决定派给谁 → 写 brief/manifest → 汇总        │ │
   └───────┬──────────────────────────────┬──────────────────────────────┘ │
           │ spawn(as|role, 能力)         │ 读产物（只读路径+摘要）        │
           ▼                              │                                │
   ┌───────────────┐  ┌───────────────┐   │                                │
   │ ① 匿名执行    │  │ ② 临时成员    │   │                                │
   │ 无 persona    │  │ inline role   │   │                                │
   └───────┬───────┘  └───────┬───────┘   │                                │
           │                  │            │                                │
           │  写自己的 by/{id}/**          │                                │
           ▼                  ▼            │                                │
   ┌────────────────────────────────────┐  │                                │
   │   vfs://team/{runKey}/             │──┘                                │
   │   brief · manifest · ledger · 产物 │                                   │
   └────────────────────────────────────┘                                   │
                        └──────────── 裁决后回到用户 ────────────────────────┘

   成员之间：不通信，只读写黑板。所有协调经过 lead。
```

### 一次团队任务的数据流

1. lead 写 `00-brief.md`（目标 + `done` 验收标准）与 `manifest.json`（成员、reads/owns）。
2. lead 派第一个任务 → 成员写 `by/{id}/10-*.md` → 返回「摘要 + 路径」（禁止返回全文）。
3. lead 更新 manifest，并行派 N 个审查 → 各写自己的 json。
4. lead 读 N 份 json（可只读摘要）→ 派仲裁 → `by/{arbiter}/90-verdict.md`。
5. lead 汇总给用户；更新 `_ledger.jsonl`；归档。

---

## 5. 数据模型

### 5.1 存储策略：状态进 OPFS，不新增表

**结论：取消 `team_tasks`，不做 v25 迁移。** 任务实体就是 `manifest.json`——它在 D5 布局里已经是「索引（唯一真相）」，再建一张表就是双写、双真相，必然发散。

```jsonc
// {projectDir}/team/{runKey}/manifest.json —— 任务实体 + 索引
{
  "runKey": "pr-335-review",
  "goal": "评估 PR #335 的 replay 正确性",
  "done": ["每条结论有 file:line", "未验证的标 UNVERIFIED"],
  "status": "running",
  "members": [
    { "id": "builder", "role": "实现", "assignee": "builder", "reads": ["00-brief.md"] },
    { "id": "gatekeeper", "role": "审查", "assignee": null, "reads": ["10-proposal.md"] }
  ],
  "artifacts": [{ "path": "by/builder/10-proposal.md", "bytes": 4210, "summary": "3 处改动" }],
  "handoff": { "taskId": "t-03", "inputs": ["10-proposal.md"], "deliverables": ["by/gatekeeper/20-review.json"] }
}
```

**为什么数据库不是必须的**：

| 原本打算靠 DB 的能力 | OPFS 替代 | 代价 |
|---|---|---|
| 任务实体 | `manifest.json` | 无；反而消除了双写 |
| 跨会话可见 | `team/` 本身在 project 级，天然跨会话 | 无（比 `project_id` 索引更直接） |
| 按成员/成本聚合 | 流式扫 `_ledger.jsonl` | L1 规模（几十个 run）足够；W4 才需要性能优化 |
| 删除项目级联 | 删 `{projectDir}/team/` | 已在 P3-4 |
| 事务 / 并发安全 | **单写者规则**：manifest 只有 lead 能写（D5 的 ACL 已强制）；ledger 也只由 lead append | 见下方约束 |
| schema 迁移 | 不需要 | 净收益 |

**必须遵守的两条 OPFS 约束**（否则会静默丢数据）：

1. **单写者**：`manifest.json` 只由 lead 写；成员不碰。成员的事件写自己的 `by/{id}/log.jsonl`。
2. **不 read-modify-write 共享 JSON**：manifest 更新 = 在内存里合并后整文件覆盖；追加类数据一律走 `.jsonl`。

**已知残余风险**：OPFS 无文件锁，两个浏览器标签页同时跑同一 `runKey` 会互相覆盖。L1 接受这个限制（单标签页假设），并在 P6 才考虑用 `navigator.locks` 加锁。

### 5.2 既有表：一个都不改

| 表 | 处置 |
|---|---|
| `workflow_agent_steps`（replay 缓存） | **不动**。它需要文本精确比对 + `ON CONFLICT(run_id, step_index)` 的 upsert，搬到 OPFS 是倒退 |
| `subagent_tasks` / `subagent_completions` | **不改 schema**。`actor` 诊断信息走日志行；task 归属靠 `runKey` + step 名约定 |
| `subagent_tasks.name` 唯一索引 | **不改索引**。临时团队用 `{role}-{runKey}` 命名规避 `idx_subagent_tasks_workspace_name` 冲突；`runKey` 本身就是不重名的 |
| `subagent_tasks` 增长 | 唯一需要碰 DB 的地方：**可选**的保留期 DELETE（P4-7）。不做就接受它增长（它的 `messages_json` 是重头） |

### 5.3 `AgentMeta` 扩展（`agents/{id}/meta.json`，**不建 SQLite 表**）

```ts
{
  id, name, createdAt, lastAccessedAt,        // 现有 4 字段
  role?: string,                               // 一句话职责，进名册
  model?: { providerType: string; modelName: string },
  capabilities?: { readonly?: boolean; allowedTools?: string[]; skills?: string[] },
  memoryPolicy?: 'off' | 'propose' | 'direct'  // 默认 'propose'
}
```

**兼容**：旧 `meta.json` 缺字段一律按 undefined 处理（等价于不限制）。**不迁移到 SQLite**——L1 不需要，等 L2 的 daemon 读不到 OPFS 时再迁。

### 5.4 `vfs://team/` 布局

见 D5。命名规则：`NN-<stage>-<name>.<ext>`，数字前缀 = 阅读顺序。

---

## 6. 接口变更

### 6.1 `SpawnSubagentInput`（`agent/tools/tool-types.ts`）

```ts
interface SpawnSubagentInput {
  description: string
  prompt: string
  subagent_type?: SubagentType        // 任务形态预设（保留）
  mode?: 'plan' | 'act'
  timeout_ms?: number
  name?: string
  // 新增
  as?: string | null                  // 常驻成员；NULL/缺省 = 匿名
  role?: string                       // inline 角色（临时成员）
  readonly?: boolean                  // 能力边界
  allowedTools?: string[]
  model?: { providerType: string; modelName: string }
  taskId?: string                     // 关联 team_tasks
}
```

**冲突规则（必须 fail-closed，不许静默选一个）**：

| 冲突 | 处理 |
|---|---|
| `readonly: true` + `mode: 'act'` | 强制 plan + 一次性 warning（照抄 `explorer` 的正例） |
| `as` 某成员 + 该成员 `capabilities.readonly` | 以 capability 为权威，忽略调用点的 mode |
| `allowedTools` + `mode` 过滤结果 | 取交集 |
| `model` + 父 run 的 provider 不兼容 | 拒绝并报可读错误，不静默回退 |

### 6.2 `agent(prompt, options)`（run_code 沙箱）

沙箱是 JSON 传输，键名沿用现有 snake_case 风格：

```js
await agent(prompt, {
  as: 'gatekeeper',        // 或省略
  role: '验证者：只跑命令、只报结果',
  readonly: true,
  allowed_tools: ['read', 'bash'],
  model: { providerType: 'openai', modelName: 'gpt-4o-mini' },
  subagent_type: 'worker',
  timeout_ms: 600000,
})
```

`normalizeOptions`（`workflow/agent-runner.ts:102-121`）需同步扩展，且 `optionsKey` 必须包含新增字段——否则 replay 会把「换了模型/换了权限」的重跑误判为缓存命中。

> **这是最容易漏的一条**：`optionsKey` 是缓存身份的一部分（`:116-118` 的注释已经说明 mode 属于 identity）。新增的 `as / readonly / model` 全都属于 identity，必须进 key。

### 6.3 结构化交接（handoff）

```ts
interface Handoff {
  taskId: string
  assignee?: string | null
  goal: string
  inputs: string[]            // 路径或短文本
  done: string[]              // 可判真假的验收标准
  deliverables: string[]      // 期望写出的路径
  budget?: { timeout_ms?: number; model?: string }
}
```

**纪律**：`done` 必须可判真假。「写得清楚」不行，「每条结论有 file:line」才行。

### 6.4 `vfs` 命名空间

`vfs-resolver.ts`：
- `namespace` union（`:53`）加 `'team'`；
- parse 支持 `vfs://team/{runKey}/{path}`；
- ACL 按 D5 三条实现（read 全开 / write 限 `by/{actor}/` / lead 白名单文件）；
- `ls-operation.ts` 增加 team 分支（现有 agents 分支散布在 `:262, :406, :654, :756`，team 复用同一形态）；
- `agent/tools/bash-worker/vfs-rpc-handler.ts:75` 增加 `/team` 挂载（可选，P3 末）；
- `ProjectManager` 删除项目时级联清理。

**默认拒绝**：未知 run / 未知 actor 一律抛可读错误，不做「自动创建」（避免拼错路径变成静默新建目录）。

### 6.5 名册注入格式（`context/sources.ts:57-64`）

现在：`${name}; delegate_to target_agent_id: ${id}`
改为：`${name} — ${role || '未声明职责'}（只读）→ spawn(as: "${id}")`，且**子代理不注入**。

### 6.6 按成员重跑（P4-4，已落地）

目标：**给定一个 `taskId`，让那个成员重新跑一次**，而不是重跑整段脚本。

#### 板上语义（已真机验证，可直接实现）

重跑 = 同一个 `taskId` 再 spawn 一次。现有代码已自然支持，无需新概念：

| 环节 | 行为 |
|---|---|
| `assignTeamTask` | 同 id 命中 `upsertTeamTask` → **保留 lead 已写的 goal**、状态回到 `running`、`updatedAt` 刷新 |
| `handoff` | 按字段合并（新值覆盖同名、旧值保留），不会因重跑丢掉 `reads` |
| `artifacts` | 上一轮的记录**保留**（`existing.artifacts` 续写），本次完成后由目录重新列举覆盖 |
| `_ledger.jsonl` | 多一条 `spawned`；完成后多一条 `done` / `blocked` —— 重跑历史天然可见 |
| 成员槽位 | 仍是 `by/{actorId|taskId}/`，**同一目录**（重跑的产物就该盖掉上一版） |

需要的唯一新能力：**从板上读出某个 task 的「上一次 prompt」**，否则“重跑”只能靠 lead 自己记得原话。两种做法：

- **A（推荐）**：manifest 的 task 增一个 `prompt_ref`（或不存，直接读 ledger + `subagent_tasks` 按 `taskId` 找最近一次 execution 的 prompt）
- **B**：不存 prompt，重跑必须由 lead 重新给 prompt（等于“再派一次活”，不是“重跑”)

倾向 **A 的第二个形式**（不改 manifest 结构，从既有表取），因为 `subagent_tasks` 已经存了每次执行的 messages。

#### replay 侧（已核实，`agent/workflow/agent-runner.ts`）

| 事实 | 位置 | 含义 |
|---|---|---|
| 步序在**调用时**分配：`const index = stepIndex++`（在 `await` 之前） | `:271` | 位置在**同一次 run 内是确定的**（等于脚本的调用顺序），所以“第 3 步”这个锚点并不像先前担心的那样会漂 |
| 命中判定：`record.prompt === prompt && record.optionsKey === optionsKey`，优先取同 index，否则在未消费的旧步里找同 prompt | `:246-262` | 比较是**文本精确**，所以重排序不会串结果；`optionsKey` 覆盖 mode/model/超时等 |
| 每个旧步只能被服务一次（`consumedPrior`） | `:238-262` | 同 prompt 出现两次不会被同一个旧步满足 |
| 一旦有一步未命中：`diverged = true` | `:281` | **重放是“前缀式”的**：从第一个分歧点往后的每一步都重跑，即使后面 prompt 没改 |
| 行写入：`runId + stepIndex + promptHash + prompt + optionsKey + agentId + name + status + result + usageJson` | `:307-320` | `name` **已落库**，但目前只用于展示；查找逻辑完全不看它 |
| run 键：`${context.workspaceId ?? 'global'}:${replay}` | `tools/run-code.tool.ts:77` | 缓存按会话隔离 |

#### 结论：P4-4 不需要 `step_id`，但需要把 `diverged` 改成“可定向”

关键发现：**“只重跑一个成员”现在表达不出来**，原因不是步序会漂，而是 `diverged = true` 把后面的步也一起拉下水。而“步序会漂”这个先前写进 P2-3 的担心，读代码后**不成立**（index 在 await 之前分配）。

所以最小改动是三件事，且不新增 DB 列：

1. **`AgentRunnerOptions` 加 `retryIndexes?: number[]`（或 `forceMiss` 谓词）**：命中这些 index 时**不设 `diverged`**，只跳过该步的缓存，其余照常命中。

   **为什么这样安全**：正确性并不是`diverged`给的，而是 **prompt 文本精确比对**给的。如果第 N 步的新答案会被拼进第 M 步的 prompt，那 M 的 prompt 就变了 → 它自然 miss（不会拿旧答案充新）。`diverged` 只是个**性能捷径**（“已经脏了，后面不看缓存的”），拿掉它不会让任何一步拿到错答案，只会让它们多比对一次字符串。
2. **`name` 当显式锚点**：team 路径下把 `taskId` 作为 `name` 传给 `agent()`，重跑时用“同 name + 同 prompt”定位。`name` 已经在落库里，不需 schema 变更；需要改的只是 `findCachedStep` 之外新增一个“按 name 找上一次”的查询。
3. **跨轮语义说清楚**：`runKey` 是**按轮次**的，所以“重跑昨天那个成员”不是重跑，而是新一次 run（能读到旧板、旧产物、旧账本，但不是同一个 manifest）。L1 就按这个算，不引入跨轮复用。

P4-5（显式 `step_id`）因此可以**降级为可选**：只在“脚本自身改动导致调用顺序变化、但仍想命中旧结果”时才真正需要，而这已由 prompt 精确比对兑底；也不用担心老行没有 `step_id` 的兼容问题。

#### 验收（A6）

- 同一 `runKey` 下只重跑一个成员 → 其它成员的 `subagent_tasks` 行数**不增加**（靠 `cached: true` 而非新 spawn）；
- 重跑后板上 `status` 从 `blocked`/`done` 回到 `running` 再到终态；
- 账本里能看出「第一次 blocked → 第二次 done」；
- 产物目录被新版本覆盖，而不是出现两份。

---

## 7. 分阶段实施

> 每个阶段独立可验证、可回滚。阶段内任务按依赖排序。

### P0 基线（0.5 天，不改行为）

**P0-2 实测结果（2026-11-20，default agent）**：每个子代理在开始干活前，先扛下面这一整包。

| 文件 | bytes | 估算 token |
|---|---:|---:|
| `SOUL.md` | 1,050 | 283 |
| `IDENTITY.md` | 178 | 48 |
| `AGENTS.md` | 1,309 | 352 |
| `USER.md` | 3,208 | 742 |
| `MEMORY.md` | 42,528 | **10,182** |
| `memory/2026-11-20.md`（今日日志） | 15,586 | 3,759 |
| **合计** | **63,859** | **≈15,365** |

> 估算方法：`wc -m` 反推 CJK 字符数，`ascii/3.7 + cjk/1.5`。单项误差约 ±10%，量级可靠。
> **含义**：单次子代理 ≈ 15.4k token 的纯人格开销（其中 `MEMORY.md` 一项就 10k）；5 人扇出 ≈ **76.8k token**，还没开始干活。

**P0-3 实测（2026-11-20，同一 prompt / 同模型 / 同为 explorer，见下方 A/B）**：

| 对照组 | input tokens | 成本 | 自述身份 |
|---|---:|---:|---|
| 匿名（无 `as`） | 17,119 | $0.0062 | 「NO，`agent-persona` 为空」 |
| `as: 'default'` | 35,200 | $0.0114 | 原文引用了「公司 = 坚果云（Nutstore）团队」+ 同事名单 |
| **差值** | **18,081** | **+83%** | — |

> 估算（15,365）比实测（18,081）**偏低 18%**：中文按 1.5 字/token 低估了。按实测，5 人扇出 ≈ **90k token** 纯开销。

| 任务 | 状态 | 产出 |
|---|---|---|
| P0-1 静态确认注入链路 | ✅ | `sources.ts:73-77` → `prompt-builder.ts:22-60`，无 `isSubagent` 判断 |
| P0-2 量 persona token 成本 | ✅ | 上表：估算 15.4k / 实测 18.1k |
| P0-3 真实请求体对照 | ✅ | A/B 探针：匿名 17,119 vs actor 35,200 input tokens；匿名自述「无身份」 |
| P0-4 基线产出质量 | ✅ | 用 A/B 代替「同一任务跑 3 次」：两组产出精度相当，匿名单还准确报出了自己看到哪些 source |

**验收**：A1 / A2 ✅（实测见上表）。**没有基线，P1 改完无法判断是变好还是变坏。**

---

### P1 匿名化 + 可选身份（2–3 天）

| 任务 | 文件 | 说明 |
|---|---|---|
| P1-1 `resolveAgent` 区分缺省/显式 null | `agent/context/sources.ts:19-23` | D1 |
| P1-2 名册/today-log 对子代理不注入 | `agent/context/sources.ts:57-81` | D1 |
| P1-3 `currentAgentId` per-execution | `agent/subagent/runtime.ts` `ensureLoop` | 现继承父值 → 改 `actorId ?? null` |
| P1-4 `SpawnSubagentInput.as` + `role` | `tools/tool-types.ts`、`tools/subagent.tool.ts`、`workflow/agent-runner.ts` | D2/D4 |
| P1-5 `role` 拼进子代理 system prompt | `agent/subagent/role-prompts.ts` | 与 4 个预设后缀并存 |
| P1-6 `optionsKey` 纳入新字段 | `workflow/agent-runner.ts:116-121` | 否则 replay 误命中 |
| P1-7 名册带 role | `context/sources.ts:63` | D4 |

**验收**：A1、A2 通过；P0-3 的对照显示产出质量未下降（或下降可解释）。

**风险**：去掉父人格后子代理可能"变笨"（缺少用户偏好与项目上下文）。缓解：如果 A/B 显示明显退化，退一步用「最小身份块」——只注入 `USER.md` 的称呼与时区，不注入 MEMORY。

**已知限制（P1 有意接受）**：`actorId` / `role` 只活在内存，**不落库**（不加列）。刷新后任务行按匿名处理，`resume` 也回落到匿名（fail-closed）。等 P6 要展示「以 X 身份执行」时再决定是否持久化。

---

### P2 能力边界（3–4 天）

| 任务 | 文件 | 说明 |
|---|---|---|
| P2-1 `AgentMeta` 扩字段 | `opfs/agent/agent-manager.ts:26-30` | `meta.json`，向后兼容 |
| P2-2 `readonly` 强制 plan | `subagent/runtime.ts` `createTask` | 照抄 explorer 正例 |
| P2-3 `allowedTools` 过滤 | `tool-registry` 加一层（在 mode 过滤之后） | 子代理的工具 schema 就该看不到 |
| P2-4 `model` 覆盖 provider | `subagent/runtime.ts` `ensureLoop` | 便宜模型干粗活 |
| P2-5 冲突 fail-closed + 可读错误 | 见 6.1 | 不许静默 |
| P2-6 inline 能力同样生效 | `agent-runner.ts` | 临时成员也要有边界 |

**验收**：A3 通过；`allowedTools` 生效是**schema 级**（模型看不见工具），不是执行级拦截。

**风险**：`allowedTools` 太严会让成员卡住（比如只给 `read` 却要求它写文件）。缓解：错误信息里列出被拒工具名 + 建议的 capability。

---

### P3 黑板 `vfs://team/`（2.5–3 天）

| 任务 | 文件 | 估 |
|---|---|---|
| P3-1 namespace + parse + backend | `tools/vfs-resolver.ts:53,124-141`、新 `TeamBoardBackend` | 1d |
| P3-2 ACL 三条 | `vfs-resolver.ts:249-275` | 0.5d |
| P3-3 `ls` 分支 | `vfs/ls-operation.ts` | 0.5d |
| P3-4 项目删除级联 | `ProjectManager` | 0.25d |
| P3-5 bash mount（可选） | `tools/bash-worker/vfs-rpc-handler.ts:75` | 0.25d |
| P3-6 manifest + ledger 约定 + lead 侧脚本 | 文档 + `run_code` 模板 | 0.5d |

**验收**：成员能写 `by/{自己}/`、被拒绝写 `by/{别人}/`；lead 能写 `00-brief.md`；刷新后产物仍在；不进 git、不出现在 sync pending 列表。

**风险**：resolver 是全库共用入口，改错会波及所有读写。缓解：namespace 隔离 + 未知 namespace 默认拒绝 + 全量 `rg "vfs://"` 回归。

---

### P4 任务实体 + 结构化交接（5–8 天）

| 任务 | 说明 |
|---|---|
| P4-1 manifest 升级为任务实体 | `agent/team/team-manifest.ts`（纯逻辑 + 单测）；**不建表**（D7） |
| P4-2 `handoff` 结构化 | spawn/`agent()` 接受 handoff → 写 manifest + 注入成员 prompt（6.3） |
| P4-3 读投影：成员 prompt 只注入 manifest 中自己的 `reads` | 决定 A4 成败 |
| P4-4 按成员重跑（replay + task id 定位） | A6 |
| P4-5 显式 `step_id` 取代自增 index | 修 `agent-runner.ts` 的步序漂移（`workflow_agent_steps` 属既有表，不改结构） |
| P4-6 task 状态机 + `_ledger.jsonl` 追加 | 6.3 / D7；ledger 由 lead 单写 |

**当前已知缺口（已由 P4-6 补齐）**：~~spawn 只写 `running`~~ → 现在终态会回写 `done` / `blocked`，并在 `_ledger.jsonl` 留痕。

**验收**：A4、A6 通过。

**风险**：`step_id` 变更会让**历史 replay 行失配**（老行没有 step_id）。缓解：老行按 `step_index` 兼容读取，新行写 `step_id`；或直接判定老 run 不可重放（更简单，建议后者）。

---

### P5 清理（约 2 天 + 2 周观察）

| 任务 | 说明 |
|---|---|
| P5-1 观测 `delegate_to` 与 `batch_spawn` 真实使用频次 | 查 `messages.meta_json` / `tool_calls`，用 `db_query` |
| P5-2 删 `batch_spawn`（含 `enableBatchSpawn` 开关与实验页那一栏） | 10 余文件一行式改动 |
| P5-3 `delegate_to` **停止写入** | 保留 `delegationNote` 读取与 `agent_input` 判定 |
| P5-4 观察 2 周后删 `delegate_to` 全链 | 12 个非测试文件，见附录 C |
| P5-5 改写名册文案（去掉 `delegate_to` 说法） | 与 P1-7 同处 |

**纪律**：**停止写入、保留读取**。历史消息里已有 `delegationNote`，删字段会让旧会话的交接消息被当成「用户说的」，影响回放与统计。

---

### P6 观测与 UI（可选，3–4 天）

- 任务条按 `runKey` 分组：成员 / 职能 / 产物路径 / 成本，可单停单重跑。
- 协作图从 `handoff_json` 画**真实边**（取代 `RunCodeRenderer.tsx:128-131` 的时间推断）。
- per-member 成本汇总。

---

## 8. 兼容与迁移

| 对象 | 处理 |
|---|---|
| 旧 `meta.json` | 缺字段按 undefined（= 不限制） |
| 旧 `subagent_tasks` 行 | 不改 schema；`actor` 只进日志，task 归属靠 `runKey` 约定 |
| 历史 `delegationNote` | 保留读取，停止写入 |
| 历史 replay 行 | 无 `step_id` → 判定为不可重放（显式拒绝，不静默重跑） |
| `batch_spawn` 用户偏好 | 设置项删除；已开启用户的配置随 store 版本失效 |
| 旧会话中的交接 UI | 退化为普通 user 气泡（内容保留） |

---

## 9. 测试计划

| 层 | 覆盖 |
|---|---|
| 单测 | `resolveAgent` 缺省 vs null；名册对子代理不注入；`normalizeOptions` 新字段进 `optionsKey`；`createTask` 的 readonly 冲突；ACL 三条的 6 种组合 |
| 集成 | 一个 `run_code` 脚本 + 假 provider，抓请求体断言「无父 persona」；两个成员写 `by/` 断言越权被拒 |
| 手动 | A1–A6 六条验收各跑一次；刷新后复盘一次；单成员失败重跑一次 |
| 回归 | `pnpm test:run agent` + `components` + `store sqlite services`；`pnpm typecheck` |

---

## 10. 风险登记与待拍板

| 风险 | 影响 | 缓解 |
|---|---|---|
| R1 去掉父人格导致产出退化 | 中 | P0 基线 + A/B；退路是「最小身份块」 |
| R2 模型自主选人不准 | 中 | role 质量 + 可纠正 UI；不确定就降级为单一默认成员 |
| R3 resolver 改动波及面大 | 高 | namespace 隔离 + 默认拒绝 + 全量回归 |
| R4 `step_id` 变更破坏历史 replay | 中 | 老行显式判不可重放 |
| R5 | 临时执行让 `subagent_tasks` 膨胀 | 低 | 可选保留期 DELETE（P4-7）；不改 schema |
| R6 | OPFS 无锁：两个标签页跑同一 `runKey` 会互相覆盖 | 中 | L1 接受单标签页假设；P6 再评估 `navigator.locks` |
| R7 | manifest 被非 lead 误写 | 中 | D5 的 ACL 已在写侧拦住；再加一条「manifest 更新必须整文件覆盖后 `read` 校验 `runKey`」 |

**需拍板（建议值）**

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 子代理的记忆写策略 | `propose`：写 `memory/inbox/`，由成员正式 run 或用户审批合入。理由：5 槽位并发写同一 `MEMORY.md` 会互相覆盖 |
| Q2 | 临时成员是否进项目名册 | 不进。只出现在当次 run 的任务条里 |
| Q3 | 团队任务是否允许跨会话 | 允许。`team/{runKey}/` 在 project 级目录下，天然跨会话，不需要额外字段 |
| Q4 | P1 之后是否立刻做 P2 | 建议是。匿名化 + 无能边界的组合最危险：模型会以为自己仍是主助理，同时仍能改任何东西 |

---

## 11. 不做清单

1. **工作流白板整合**：`flow/types.ts:22` 节点无 agent 类型、`flow_templates` 0 行、与 `run_code` 两套执行器。
2. **成员聊天室 / 广播**：会立刻变成不可终止、不可复现、成本无界的自由对话。
3. **成员递归派活**：保持一级扇出（`subagentRuntime: undefined` 是有意设计）。
4. **把 agents 迁到 SQLite**：L1 不需要；等 L2 的 daemon 读不到 OPFS 时再迁。
5. **「全绑」模式**：匿名执行路径必须保留，否则临时调研也要先招人。

---

## 附录 A · 现状证据索引（本会话实测）

| 事实 | 位置 |
|---|---|
| 子代理隐式继承父代理身份 | `store/conversation-agent-run.ts:1099` → `agent/subagent/runtime.ts:1195` → `agent/agent-loop.ts:165-170` → `agent/context/sources.ts:73-77` |
| `agentOverrideId` 捕获但无人消费 | `store/conversation-agent-run.ts:1086`、`agent/subagent/runtime.ts:260` |
| 名册只有 id+name | `agent/context/sources.ts:57-64` |
| persona 兜底回 default | `agent/context/sources.ts:19-23` |
| 子代理不能嵌套 | `agent/subagent/runtime.ts:1201`（`subagentRuntime: undefined`）+ `:149`（控制工具集） |
| 刷新降级为 failed | `agent/subagent/runtime.ts:1819` |
| 并发槽 5 / 超时 10min–1h | `agent/subagent/runtime.ts:179,163` |
| 读无隔离、写有隔离、default 超管 | `agent/tools/vfs-resolver.ts:269,191-195,193` |
| 子代理不看 protected agent 文件 | `agent/tools/vfs-resolver.ts:249-256` |
| `AgentMeta` 仅 4 字段 | `opfs/agent/agent-manager.ts:26-30` |
| `subagent_tasks` 结构 + 唯一 name 索引 | `sqlite/sqlite-schema.sql:94-124` |
| `delegate_to` 单向 + transient | `agent/tools/delegate.tool.ts:9-14`、`store/conversation-agent-run.ts:2509` |
| `batch_spawn` 默认关 | `store/settings.store.ts:1016`、`agent/tool-registry.ts:407` |
| run_code 沙箱 blocked 名单 | `services/tool-invocation.ts:13` |
| `agent()` 返回 `{content, agentId, cached}` | `agent/tools/run-code.tool.ts:94` |
| `optionsKey` 属于缓存身份 | `agent/workflow/agent-runner.ts:116-121` |
| 并行层是时间推断，非 DAG | `components/agent/tool-renderers/RunCodeRenderer.tsx:128-131` |

## 附录 B · 与 Claude Code subagents 的对照

| 维度 | Claude Code | 本项目现状 | 结论 |
|---|---|---|---|
| 成员定义 | 声明式文件，frontmatter 含 `tools` / `model` / `description` | `meta.json` 4 字段 | **真差距** → P2 |
| 子代理上下文 | 全新，只带任务与自身定义 | 隐式继承父代理整份人格 | **真差距（且现状更糟）** → P1 |
| 谁决定派活 | 模型看 `description` 自主决定 | 名册无 role，模型选不准 | **真差距** → P1 |
| 成员间通信 | 不直接通信；结果经编排者 | 同构 | 无差距 |
| 子代理能否再派活 | 不能 | 不能 | 同构 |
| 可重放 | 无 | `run_code` replay | **本项目更强** |

## 附录 C · `delegate_to` 删除面（非测试文件，12 个）

| 文件 | 处数 | 说明 |
|---|---|---|
| `agent/tools/delegate.tool.ts` | 17 | 整文件 |
| `store/conversation-agent-run.ts` | 20 | `pendingDelegation` / `delegationDepth` / 交接 note / `transient` |
| `agent/message-types.ts` | 7 | `delegationNote`、`delegationDepth`、两处 `agent_input` 判定 |
| `agent/intelligence-coordinator.ts` | 4 | 整段为死代码（`buildAvailableAgentsBlock` 无生产调用） |
| `components/agent/MessageBubble.tsx` | 3 | 交接卡片渲染 |
| `sqlite/message-meta.ts` · `message.repository.ts` · `services/export/conversation-export.ts` | 4 | 持久化与导出 |
| `agent/policy-engine.ts` · `agent-mode.ts` · `tool-registry.ts` · `context/sources.ts` | 5+ | 白名单 / 分类 / 注册 / 名册文案 |

---

## 12. 下一步

1. 你确认 Q1–Q4 四个待拍板项（或让我按建议值执行）。
2. 我按 P0 → P1 顺序开工，P0 的产出会先给你看两份请求体对比。
3. 每个阶段结束跑 `pnpm typecheck` + 对应测试分块，并在 PR 里附该阶段验收项的实际结果。
