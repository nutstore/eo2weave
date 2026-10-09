# EO2Weave

<div align="center">

**EO2Weave：本地优先的 AI 原生创作平台，支持创作、知识沉淀与多代理编排**

[![Rust](https://img.shields.io/badge/Rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-18%2B-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Chrome 应用商店](https://img.shields.io/chrome-web-store/v/canpcddlognjbengiodekfbbfnjafeml?logo=googlechrome&logoColor=white&label=Chrome%20%E5%BA%94%E7%94%A8%E5%95%86%E5%BA%97)](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml)
[![用户数](https://img.shields.io/chrome-web-store/users/canpcddlognjbengiodekfbbfnjafeml?logo=googlechrome&logoColor=white&label=%E7%94%A8%E6%88%B7%E6%95%B0)](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml)
[![Edge 加载项](https://img.shields.io/badge/Edge%20%E5%8A%A0%E8%BD%BD%E9%A1%B9-v1.1.7-0C7BBB?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm)

[English](./README.md) | 简体中文

立即体验在线 Demo：[weave.eo2suite.cn](https://weave.eo2suite.cn/)

</div>

## 项目简介

EO2Weave 是一款 **本地优先的 AI 原生创作平台**。它将本地文件工作流、AI 对话协作、知识沉淀与多代理能力整合在同一套浏览器应用中。

## 项目初衷（Why EO2Weave）

- 面向纯文本内容创作：减少在编辑器、浏览器、终端之间来回切换导致的思路中断。
- 从浏览器优先出发：开箱即用，不需要先安装 IDE 或复杂本地环境。
- 兼顾易用与安全：通过文件夹授权映射访问本地文件，访问范围受浏览器权限模型限制。
- 降低多分支认知成本：提供工作区（Workspace）并行机制，思路类似 `git worktree`，但不要求用户理解 Git 细节。

此外，项目也在探索面向内容创作的多智能体协作工作流：通过可配置角色与协作模式，让多个智能体共同完成复杂创作任务。

## 主要特性

- **AI 对话与工具调用**：基于多代理能力对代码与文件进行理解、分析和执行操作
- **本地优先**：通过浏览器 File System Access API 与本地文件交互
- **高性能存储**：SQLite WASM + OPFS（支持 IndexedDB 回退）
- **Python 集成**：基于 Pyodide 在浏览器中运行 Python
- **WebMCP 支持**：任何网站都能通过标准 WebMCP API 把能力暴露成 agent 可调用的工具，配套浏览器扩展自动发现与授权
- **无后端、不收集**：文件、对话、配置全部存于浏览器本地（OPFS）；AI 请求由浏览器直连你配置的模型服务商（BYOK），不经手我们的服务器
- **数据与可视化**：支持表格、图表、导出等数据分析流程

## 浏览器扩展

EO2Weave 扩展把 AI 助手装进浏览器侧边栏：感知当前页面内容、联网搜索与网页阅读、按 WebMCP 标准自动发现网站工具。同时通过 OAuth 桥接你的 ChatGPT / Codex 订阅，无需配置 API Key 即可调用 GPT 系列模型。

| 渠道 | 安装方式 |
|------|----------|
| Chrome / Chromium | [从 Chrome 应用商店安装](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml) |
| Edge | [从 Edge 加载项安装](https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm) |
| 手动安装（任意 Chromium 浏览器） | EO2Weave →「设置 → 浏览器扩展」下载安装包，按页面内向导加载 |

凭证不出本机：OAuth 令牌保存在扩展本地存储中，请求由浏览器直连服务商，EO2Weave 服务器不经手。

## 快速开始

### 环境要求

- Rust 1.75+
- Node.js 18+
- pnpm 10.21.0（推荐通过 [mise](https://mise.jdx.dev/) 或 Corepack 管理）

### 安装

```bash
git clone https://github.com/nutstore/eo2weave.git
cd eo2weave

# 推荐：按项目配置安装 pnpm 10.21.0
mise install

# 未安装 mise 时，可先启用 Corepack
# corepack enable
pnpm install
```

### 开发

```bash
# 启动开发环境
make dev
# 或
pnpm -C web run dev

# 默认访问
# http://localhost:5173
```

### 构建

```bash
make build
```

## 文档索引

- [文档总览](./docs/README.md)
- [用户指南](./USER_GUIDE.md)
- [开发者指南](./DEVELOPER_GUIDE.md)
- [开发者文档入口（中文）](./docs/developer/guides/index.md)
- [开发指南（English）](./docs/development/README.md)
- [架构文档](./docs/architecture/overview.md)
- [SQLite 存储说明](./web/sqlite/README.md)

## Roadmap（待实现）

- [ ] **附件目录（规划中）**：工作区级附件存储，支持在对话中上传文件。Agent 通过 `vfs://attachments/` 路径使用现有 `read`/`ls` 工具访问附件。设计文档整理中。
- [ ] **SubAgent 编排能力（规划中）**：提供原生 SubAgent 分发、并行调度、结果聚合，以及跨代理上下文隔离与交接质量保障能力。

## 参与贡献

欢迎提交 Issue 和 PR。请先阅读：

- [Contributing Guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
