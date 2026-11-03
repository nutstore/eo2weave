---
name: cw-impeccable-design
description: "Frontend design skill from pbakaus/impeccable, ported for EO2Weave. Trigger when user asks to design, redesign, refine, polish, audit, critique, distill, harden, animate, colorize, typeset, layout, clarify, adapt, optimize, extract, document, init, shape, bolder, quieter, delight, overdrive, onboard, live-iterate, or ux-review any frontend UI work. Covers websites, landing pages, dashboards, product UI, app shells, components, forms, settings, onboarding, empty states. Handles visual hierarchy, information architecture, cognitive load, a11y, performance, responsive, theming, anti-patterns, typography, spacing, alignment, color, motion, micro-interactions, UX copy, error states, edge cases, i18n, design systems, tokens. Also use for bland designs that need to become bolder, loud designs that need to become quieter, or ambitious visual effects that should feel technically extraordinary."
description.zh-CN: "来自 pbakaus/impeccable 的前端设计技能，已适配 EO2Weave。当用户要求设计、重设计、打磨、优化、审查 UI，调整排版、配色、动画、布局、层次，或希望界面更有质感、更克制、更愉悦时触发。"
description.ja-JP: "pbakaus/impeccable のフロントエンドデザインスキルを EO2Weave 向けに移植したもの。UI の設計・再設計・磨き・最適化・レビュー、タイポグラフィ、配色、アニメーション、レイアウト、階層の調整、あるいは UI をより上質に・より落ち着いて・より魅力的にしたいときにトリガーされます。"
description.ko-KR: "pbakaus/impeccable의 프런트엔드 디자인 스킬을 EO2Weave용으로 포팅한 것입니다. UI 설계·재설계·다듬기·최적화·검토, 타이포그래피·색상·애니메이션·레이아웃·위계 조정, 또는 UI를 더 세련되고·더 절제되고·더 매력적으로 만들고 싶을 때 트리거됩니다."
category: general
tags: [design, frontend, ux, ui, review, polish, anti-pattern, design-system]
triggers:
  keywords:
    # English command keywords (23 commands)
    - polish
    - audit
    - critique
    - distill
    - harden
    - typeset
    - layout
    - animate
    - colorize
    - clarify
    - adapt
    - optimize
    - extract
    - document
    - init
    - shape
    - live
    - bolder
    - quieter
    - delight
    - overdrive
    - onboard
    - refine
    - redesign
    - frontend
    - "design review"
    - "ux review"
    - "ui design"
    - "design system"
    - "anti-pattern"
    - "micro-interaction"
    - "impeccable"
    # Chinese keywords
    - 精修
    - 抛光
    - 打磨
    - 审查
    - 审计
    - 评估
    - 批评
    - 设计审查
    - 设计评估
    - 改版
    - 重做
    - 改进
    - 提炼
    - 硬固
    - 动画
    - 动效
    - 配色
    - 字体
    - 排版
    - 布局
    - 澄清
    - 适配
    - 优化
    - 提取
    - 文档化
    - 塑形
    - 大胆
    - 安静
    - 提亮
    - 加深
    - ux 评审
    - ui 设计
    - 前端设计
    - 设计系统
    - 反模式
    - 微交互
    - 上手引导
---

# Impeccable Design

> Port of [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache 2.0) — 1 skill, 23 commands, fight AI design slop. Original repo uses `npx impeccable install` for Claude Code/Cursor/Codex; this version is a pure-prompt skill for EO2Weave, no install needed.

## 何时使用本 skill

**直接触发**（用户明确说某个 command）：
- 「帮我 polish 一下这个 hero」「/impeccable audit 这个页面」「/audit」「/polish」
- 「distill 这个设计」「bolder 一点」「quieter 一些」
- 「把这个 UI 适配 mobile」

**隐式触发**（用户在设计 / 改 UI / 找问题）：
- 用户粘贴一段代码问「怎么改更好看」
- 用户说「这个页面怎么这么丑」「我想要更专业的设计」
- 用户在做新页面/落地页/组件

**不触发**：
- 后端逻辑、纯数据处理、文档/文章写作
- 没有视觉输出的工作（CLI 工具、API、脚本）

---

## 核心哲学

```
This skill gives you the tools and permission to create design
that earns to be called out-of-distribution craft:

- Go all out. No hedging, no shortcuts.
- Dream big and bold. Distinct, beautiful, outstanding work.
- Verify in bounded passes, not a loop. Build fully, inspect
  once with a batched round (desktop and mobile together),
  fix everything it shows in one batch, confirm with at most
  one more round, and stop polishing.
- The brief wins. Honor pinned aesthetics, eras, materials,
  fonts, and palettes even when they conflict with a habit
  warning. Redirecting a clear brief toward your taste is
  failure.
- Refinement preserves; redesign replaces. Refinement keeps
  the incumbent identity, behavior, copy, and everything
  outside scope. Ask before replacing factual copy or adding
  claims.
```

**AI slop 是什么**：每个模型训练数据相同，默认会产出相同的几个特征——Inter 字体、紫蓝渐变、卡片套卡片、灰字配彩色背景、heading 上方的圆角图标方块。本 skill 的全部 command 都在对抗这些。

---

## 4 种 Mode

**Mode 命名这个 surface 上访客的成功长什么样**。一个产品可以同时有多个 surface（落地页 = Persuade，设置页 = Operate，文档 = Read）。

| Mode | 访客要做什么 | 典型 surface | 设计优先级 |
|------|------------|-------------|-----------|
| **Persuade** | 决定并行动 | 落地页、营销、活动页、定价页 | 注意力 + 行动，design IS the product |
| **Operate** | 完成一个任务 | App UI、仪表盘、编辑器、admin、设置、工具 | 可扫读性、一致性、原生预期；brand 活在细节里 |
| **Read** | 理解某事 | 文档、文章、指南、help、changelog | 结构服务理解，然后让阅读体验值得停留 |
| **Experience** | 沉浸在作品里 | Portfolio、画廊、showcase | 作品先于界面，界面退后 |

**如何选 mode**：从**用户当前在做的 surface** 选，**不是从产品选**。工具的落地页仍然是 Persuade；时装屋的文档仍然是 Read。

---

## Setup 流程

每次执行 design command 前，**严格按顺序**做这 3 步：

### Step 1：加载上下文

读取（如果存在）：
- `PRODUCT.md`（项目根或 `.impeccable/`）— 用户/产品上下文
- `DESIGN.md`（项目根或 `.impeccable/`）— 设计系统
- `.impeccable/surfaces/*.md`（如果存在）— 单个 surface 的 brief
- `.impeccable/config.json`（如果存在）— 平台、ignore 列表等

如果都没有 → 建议先跑 `/impeccable init`（见 commands/init.md）。**不要因为没 init 就拒绝工作**——可以先做 init 之外的工作，最后再问要不要 init。

### Step 2：加载对应 command 的 reference

在 `references/commands/<command>.md` 读该 command 的具体指令。

如果用户没指定 command（只说 `/impeccable`），读 `references/routing.md` 看 context-aware 路由建议。

### Step 3：编辑 UI 前加载 craft-floor

读 `references/craft-floor.md`（质量底线 + 绝对禁令）。**这一条是必须的**——craft-floor 包含 detector 抓不到但肉眼可见的"AI tells"。

---

## 23 个 Command 路由表

加载对应 reference 文件后按其指令执行。

### Build（创建/记录）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `init` | `commands/init.md` | 项目首次接入：捕获 PRODUCT.md / DESIGN.md / 平台信息 |
| `document` | `commands/document.md` | 从现有代码生成 DESIGN.md |
| `extract` | `commands/extract.md` | 把可复用的 token / 组件抽到 design system |
| `shape` | `commands/shape.md` | 写代码前先规划 UX/UI 形状 |
| `craft` | `commands/craft.md` | 旧别名，等价于新 surface 的 new-work 流程 |

### Evaluate（评估/审查）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `critique` | `commands/critique.md` | UX 设计评审，heuristic 评分（独立 .md，~800 行） |
| `audit` | `commands/audit.md` | 技术质量审查（a11y/perf/responsive/theming/完整性），5 维 0-4 分 |

### Refine（精修）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `polish` | `commands/polish.md` | 上线前最后一轮质量把关（5 步：建立系统→证据→分类→精修路径→验证） |
| `bolder` | `commands/bolder.md` | 把平淡设计放大胆 |
| `quieter` | `commands/quieter.md` | 把夸张设计变安静 |
| `distill` | `commands/distill.md` | 提炼本质，去除复杂度 |
| `harden` | `commands/harden.md` | 生产化：错误处理、i18n、边缘情况（~340 行大指南） |
| `onboard` | `commands/onboard.md` | 首次使用流程、空状态、激活路径 |

### Enhance（增强）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `animate` | `commands/animate.md` | 加有目的的动效 |
| `colorize` | `commands/colorize.md` | 给单色 UI 加策略性色彩 |
| `typeset` | `commands/typeset.md` | 修字体、字号、层级 |
| `layout` | `commands/layout.md` | 修间距、节奏、视觉层级 |
| `delight` | `commands/delight.md` | 加人格化和值得记忆的小细节 |
| `overdrive` | `commands/overdrive.md` | 突破常规极限（~280 行技术效果指南） |

### Fix（修复）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `clarify` | `commands/clarify.md` | 改进 UX 文案、标签、错误信息 |
| `adapt` | `commands/adapt.md` | 适配不同设备/屏幕尺寸（web 通用，native 见 .native） |
| `optimize` | `commands/optimize.md` | 诊断并修复 UI 性能 |

### Iterate（迭代）

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `live` | `commands/live.md` | 视觉变体模式：用户在浏览器里挑元素，生成替代方案 |

### 共享 Playbook（任何 command 都会按需加载）

| 文件 | 何时加载 |
|------|---------|
| `craft-floor.md` | **Step 3 必须** —— 质量底线 + 绝对禁令 |
| `routing.md` | 用户调 `/impeccable` 无参数时 |
| `new-work.md` | 新 surface 或替换视觉世界时（最大共享文档，~110 行） |
| `operate.md` | Operate / Read 模式深入 |
| `ios.md` | 平台 = iOS 时 |
| `android.md` | 平台 = Android 时 |

### 工具命令

| Command | Reference | 何时用 |
|---------|-----------|--------|
| `audit.native.md` | iOS/Android 原生版的 audit 变体 |
| `adapt.native.md` | iOS/Android 原生版的 adapt 变体 |
| `hooks.md` | 设计 detector hook 管理（EO2Weave 不直接支持，留作参考） |
| `doctor.md` | 报告/修复 drift（EO2Weave 不直接支持，留作参考） |

---

## 关键概念速查

### 1. Brief wins（brief 优先于品味）

如果用户在 PRODUCT.md 或对话中给出了 pinned 的审美、时代感、材质、字体、配色 —— **严格遵守**。即使 craft-floor 警告"太多饱和度"，也不要改。

误判 signal：发现自己说"虽然 brief 说 X，但我觉得 Y 更好" —— 这是品味在抢戏。**Brief wins**.

### 2. Refinement vs Redesign

- **Refinement（polish/quieter/bolder/distill）**：保留当前视觉世界、内容、行为、scope 外的一切。**禁止**偷偷换成"我更喜欢的样子"。
- **Redesign（new-work + replace）**：保留产品事实、内容、功能、原生 affordance、约束，把旧视觉当作 evidence 和 anti-reference。**选择一个新的视觉世界，全盘替换 DESIGN.md。**
- **绝不做**"在废弃的视觉上 polish" —— 这是分裂行为。

### 3. 绝对禁止（craft-floor 全文）速览

**Page scaffold 禁令**：
- 同样大小的 icon + heading + text 卡片网格（卡片是偷懒容器）
- Hero-metric 模板（大数字 + 小标签 + 支撑 stats + 强调色）
- Heading 上方的 kicker / eyebrow label（**绝对 ban，无 brief 能解锁**）
- 段落编号 (01/02/03) 除非序列本身承载信息
- 不需要中断/保护焦点的任务用 modal

**Surface 习惯禁令**：
- 渐变文字（强调应该来自字重或字号）
- 玻璃/blur 当装饰
- 卡片/列表项/callout/alert 的彩色 border-left/right 超过 1px
- 硬偏移阴影（box-shadow: 4px 4px 0）除非真的是 neobrutalist 世界
- Sparkline、progress ring、软阴影圆角矩形假装是内容
- Monospace 假装"技术感"（应该只用于代码/数据/测量）
- 系统 display 字体（Impact/Arial Black/platform sans）当作品牌的 display voice
- Unicode glyph 或 emoji 假装图标系统（图标必须绘制，统一 stroke/weight）

**Codex/Gemini 专属**：
- Codex：tracking 停在 -0.04em；elevation 只声明一次（border 或 shadow）；卡片圆角 12-16px；不要 sketch 风 SVG；不要 grid overlay 假装技术感
- Gemini：永远不要让图片在 hover 时动（图片不是 action target，给容器加反馈）

**完整 craft-floor 看 `references/craft-floor.md`。**

### 4. 验证节奏

**不要循环自检**。`build fully → batched inspection round (desktop+mobile 一起) → fix everything in one batch → at most one more round → stop`.

无界自检花用户钱做更差的事，finish handoff 做得更好。

---

## 工作流示例

### 示例 1：用户说「/impeccable polish 这个 hero」

1. Setup Step 1: 读 PRODUCT.md / DESIGN.md（如有）
2. Setup Step 2: `read_skill_resource("cw-impeccable-design", "references/commands/polish.md")`
3. Setup Step 3: `read_skill_resource("cw-impeccable-design", "references/craft-floor.md")`
4. 按 polish.md 5 步走：建立系统 → 证据 → 分类 → 精修整个路径 → 验证
5. 输出 diff 摘要 + 真实改进

### 示例 2：用户说「这个页面怎么这么丑」（没指定 command）

1. Setup Step 1: 找 PRODUCT.md / DESIGN.md
2. Setup Step 2: 读 `references/routing.md`（无参数路由）
3. 推荐 2-3 个最有价值的 command（基于信号）
4. **不自动跑** —— 等用户确认

### 示例 3：用户说「做一个落地页」

1. Setup Step 1: 找 PRODUCT.md，没有就问要不要 init
2. Setup Step 2: 读 `references/commands/craft.md` 或 `references/new-work.md`
3. Mode = Persuade（落地页）
4. new-work 流程：选一个 visual world → 写 surface brief → 替换或新建 DESIGN.md → 写代码

### 示例 4：用户说「audit 一下设置页」

1. Setup Step 1: 找 PRODUCT.md / DESIGN.md
2. Setup Step 2: 读 `references/commands/audit.md`
3. 按 audit.md 5 维 0-4 分：a11y / perf / responsive / theming / implementation integrity
4. 生成报告：P0-P3 严重度 + 推荐 command（用本 skill 的 23 个）
5. **不修任何东西** —— 报告是给其他 command 用的

---

## 平台适配

| 平台 | 何时用 | 加载 reference |
|------|--------|--------------|
| `web` | 网站或 web app（含 responsive mobile web），**默认** | 无需额外文件，SKILL.md 通用规则已覆盖 |
| `ios` | 原生 iOS / iPadOS app | `references/ios.md`（Apple HIG 摘要） |
| `android` | 原生 Android app | `references/android.md`（Material Design 3 摘要） |
| `adaptive` | 跨平台（Flutter / React Native / KMP） | `references/ios.md` + `references/android.md` |

PRODUCT.md 的 `## Platform` 字段决定加载哪些。EO2Weave 中：用户告诉你在哪个平台，或者在 PRODUCT.md / 对话中推断（web 默认）。

---

## 关键资源

| 资源 | 路径 | 何时读 |
|------|------|--------|
| 核心哲学 + 4 mode + 命令路由 | （本 SKILL.md） | 每次触发 |
| 质量底线 + 绝对禁令 | `references/craft-floor.md` | **编辑 UI 前必读** |
| 无参数路由逻辑 | `references/routing.md` | 用户调 `/impeccable` 无参数时 |
| 新建 surface / 替换视觉世界 | `references/new-work.md` | 全新设计或大改版 |
| Operate / Read 模式深入 | `references/operate.md` | App UI、文档、dashboard |
| 23 commands 具体指令 | `references/commands/*.md` | 对应 command 被调用时 |
| iOS 平台适配 | `references/ios.md` | 平台 = iOS |
| Android 平台适配 | `references/android.md` | 平台 = Android |
| PRODUCT.md 模板 | `assets/PRODUCT.template.md` | 新项目 init 时 |
| DESIGN.md 模板 | `assets/DESIGN.template.md` | 新项目 init / document 时 |
| 59 条 anti-pattern 设计原则 | `assets/anti-patterns.md` | 任何 design 工作的参考清单 |

---

## 重要 caveat

**本 skill 是 prompt-based**，原版 Impeccable 的以下功能在 EO2Weave 中**不可用**（或不直接支持）：

- ❌ `npx impeccable detect <file>` CLI detector（bash sandbox 无 npx/node）→ 改用 `assets/anti-patterns.md` 设计原则，**让 LLM 在 review 时手动执行**
- ❌ Provider hooks（自动 PostToolUse 触发 detector）→ EO2Weave 无 hook 机制
- ❌ `npx impeccable live` 浏览器实时迭代（需 puppeteer）→ EO2Weave 本身就是浏览器 IDE，用户直接在文件树挑元素即可

**这些限制不影响核心价值**：23 个 command 的 prompt 内容、4 mode 哲学、craft-floor 禁令都是**纯文档**，可以 100% 在 EO2Weave skill 体系中复用。

---

## 致谢

- **原始作者**：[Paul Bakaus](https://github.com/pbakaus) (pbakaus/impeccable)
- **上游仓库**：https://github.com/pbakaus/impeccable
- **协议**：Apache 2.0（attribution 已保留在 NOTICE.md）
- **iOS / Android 平台指南**：[ehmo/platform-design-skills](https://github.com/ehmo/platform-design-skills) (MIT)
- **Port 时间**：2026-07-31
- **Port 作者**：EO2Weave AI assistant
