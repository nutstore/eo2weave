# EO2Weave

<div align="center">

**EO2Weave: a local-first AI-native platform for creation, knowledge workflows, and multi-agent orchestration**

[![Rust](https://img.shields.io/badge/Rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-18%2B-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/canpcddlognjbengiodekfbbfnjafeml?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml)
[![Users](https://img.shields.io/chrome-web-store/users/canpcddlognjbengiodekfbbfnjafeml?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml)
[![Edge Add-ons](https://img.shields.io/badge/Edge%20Add%C2%AD-ons-v1.1.7-0C7BBB?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm)

English | [简体中文](./README.zh.md)

Try the live demo: [weave.eo2suite.com](https://weave.eo2suite.com/)

</div>

## What is EO2Weave?

EO2Weave is a **local-first AI-native creation platform**. It combines file workflows, AI copilots, knowledge-base workflows, and multi-agent orchestration in one browser-native product.

## Why EO2Weave?

- Built first for plain-text creation workflows: reduce context switching between editors, browsers, and terminals.
- Browser-first by design: quick onboarding without requiring users to install an IDE or a heavy local setup.
- Balances usability and safety: local files are accessed through explicit folder authorization, with scope constrained by browser permission boundaries.
- Lowers branching complexity for non-Git users: workspaces can run in parallel, conceptually similar to `git worktree`, without requiring Git knowledge.

The project is also exploring multi-agent collaboration workflows for content creation, with configurable agent roles and coordination modes.

### Key Product Description

- **AI-Powered Conversations**: Chat naturally with your codebase using advanced AI agents with multi-agent collaboration
- **Knowledge Workflows**: Build reusable context from project files and structured notes
- **Multi-Agent Orchestration**: Design and run multi-step creative workflows with specialized agents
- **Local File Access**: Direct interaction with files through modern browser APIs (File System Access API)
- **Code Intelligence**: Understand, analyze, and manipulate code with 30+ intelligent tools
- **Python Integration**: Execute Python code in the browser with Pyodide (pandas, numpy, matplotlib support)
- **WebMCP Support**: Any website can expose agent-callable tools via the standard WebMCP API — the companion browser extension discovers and invokes them automatically
- **No Backend, No Tracking**: Files, conversations, and settings live in your browser (OPFS); we collect nothing. AI requests go directly from your browser to the LLM provider you configure (BYOK) — they never pass through our servers

## Features

### Conversation System
- **Threading**: Organize conversations into threads for better context management
- **Message Bubbles**: Rich message display with markdown support, syntax highlighting, and inline code rendering
- **Reasoning Visualization**: See AI thinking process with collapsible reasoning sections
- **Tool Call Display**: View all tool invocations with parameters and results
- **Run Change Summary**: See a per-run card in the message stream listing exactly which files each agent run changed, with inline diffs and rollback linkage
- **Auto-apply on completion**: Optionally apply a completed run's eligible file changes to your local folder automatically, while keeping every change visible and rollback-safe in the message stream
- **Change Safety Nets**: Every applied change is captured in a persisted snapshot with a visible per-run card and easy rollback
- **Streaming Support**: Real-time streaming of AI responses for faster feedback

### Code Intelligence
- **File Tree Panel**: Browse and explore your project structure
- **Syntax Highlighting**: Code display with Shiki syntax highlighting
- **File Comparison**: Side-by-side diff view for comparing file versions
- **Code Navigation**: Quick access to files with line numbers and search

### Data Analysis
- **Data Visualization**: Chart.js integration for visualizing file statistics
- **Data Preview**: Preview JSON, CSV, and other structured data formats
- **Batch Operations**: Apply changes to multiple files at once
- **Advanced Search**: Regex-based search with context lines
- **Data Export**: Export analysis results to CSV, JSON, Excel, or image formats

### Workspace Management
- **Theme Support**: Light, dark, and system theme options
- **Keyboard Shortcuts**: Command palette for quick access to all features (press `Ctrl+K` or `Cmd+K`)
- **Recent Files**: Quick access to recently viewed files
- **Layout Persistence**: Your workspace layout is saved automatically
- **Onboarding Tour**: Guided tour for first-time users

### Development Tools
- **Skills Manager**: Create and manage reusable AI skills with on-demand loading
- **Tools Panel**: Access 30+ development tools including file operations, code analysis, and data visualization
- **Python Integration**: Execute Python code in the browser (Pyodide) with pandas, numpy, matplotlib, openpyxl
- **MCP Integration**: Configure Model Context Protocol providers for extended capabilities
- **WASM Acceleration**: High-performance file operations using Rust-compiled WebAssembly modules

### WebMCP & Browser Extension

- **WebMCP Tool Discovery**: Any website can register agent-callable tools via the standard WebMCP API (`document.modelContext`) — no private protocol, no allowlist; the extension discovers standard-conforming tools automatically and keeps a live per-tab registry
- **Authorization Controls**: Grant or revoke access per site and per tool group from the extension popup
- **Agent Web Access**: Built-in `web_search` / `web_fetch` tools let in-browser agents search and read the web
- **Native Host (optional)**: Rust companion process provides local disk and command execution bridges

### User Scenarios
- **Developers**: Code understanding, refactoring, debugging, and code review
- **Data Analysts**: Data exploration, visualization, and report generation
- **Students**: Learning assistance, problem-solving with step-by-step guidance
- **Office Workers**: Document processing, data transformation, and automation

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Open command palette |
| `Ctrl/Cmd + B` | Toggle sidebar |
| `Ctrl/Cmd + ,` | Open workspace settings |
| `Ctrl/Cmd + 1/2/3` | Switch resource tabs |
| `Shift + ?` | Show keyboard shortcuts |
| `Escape` | Close panels/dialogs |

## Browser Extension

The EO2Weave extension puts an AI assistant in your browser sidebar — page-aware Q&A, web search & reading, and WebMCP tool discovery. It also bridges your ChatGPT / Codex subscription via OAuth, so you can call GPT models without managing API keys.

| Store | Install |
|-------|---------|
| Chrome / Chromium | [Install from Chrome Web Store](https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml) |
| Edge | [Install from Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm) |
| Manual (any Chromium browser) | EO2Weave → **Settings → Browser Extension** to download the package and follow the in-app guide |

Credentials stay on your device: OAuth tokens are stored in the extension's local storage and requests go directly from your browser to the provider — EO2Weave servers never see them.

## Getting Started

### Prerequisites

- Node.js (18+)
- pnpm 10.21.0 (managed with [mise](https://mise.jdx.dev/) or Corepack)
- A modern browser with File System Access API support

### Quick Start

```bash
# Clone the repository
git clone https://github.com/nutstore/eo2weave.git
cd eo2weave

# Install the pinned pnpm version (recommended)
mise install

# Alternative without mise: enable Corepack, then install dependencies
# corepack enable
pnpm install

# Start desktop web app
pnpm -C web run dev

# Open http://localhost:5173
```

### Building for Production

```bash
# Build WASM modules
pnpm -C web run build:wasm

# Build web application
pnpm -C web run build

# Output in web/dist/
```

## Development

### Project Structure

```
eo2weave/
├── web/                    # React frontend application (Desktop)
│   ├── src/
│   │   ├── agent/         # AI agent logic, tools, multi-agent collaboration
│   │   ├── components/    # React components (UI, conversation, code viewer)
│   │   ├── hooks/         # Custom React hooks
│   │   ├── store/         # State management (Zustand stores)
│   │   ├── sqlite/        # SQLite WASM database layer
│   │   ├── python/        # Pyodide Python integration
│   │   ├── workers/       # Web Workers (file discovery, plugins)
│   │   └── export/        # Data export functionality
│   └── package.json
├── wasm/                   # Rust + WebAssembly modules
│   └── crates/            # Core logic, WASM bindings, plugin API/SDK
├── packages/               # Monorepo shared packages
│   ├── ui/                # Shared UI components (Radix UI + Storybook)
│   ├── conversation/      # Conversation components
│   ├── encryption/        # E2E encryption (ECDH + AES-GCM)
│   ├── i18n/              # Internationalization
│   └── config/            # Shared configurations
├── docs/                   # Project documentation
│   ├── architecture/      # Architecture documentation
│   ├── development/       # Development guides
│   └── design/            # Design specifications
└── scripts/                # Development and build scripts
```

### Available Scripts

```bash
# Desktop Web (web/)
pnpm -C web run dev
pnpm -C web run build
pnpm -C web run preview

# Quality (web/)
pnpm -C web run lint
pnpm -C web run typecheck
pnpm -C web run test
pnpm -C web run test:e2e
```

## Documentation

- [Documentation Index](./docs/README.md) - Central docs entry and maintenance conventions

### User Documentation
- [User Guide](./USER_GUIDE.md) - How to use all features
- [Changelog](./CHANGELOG.md) - Version history and changes

### Developer Documentation
- [Developer Portal (CN)](./docs/zh/developer/guides/index.md) - Structured developer docs in Chinese
- [Quick Start Guide (EN)](./docs/en/developer/quick-start.md) - Get started in 5 minutes
- [Architecture Overview](./docs/zh/developer/architecture/overview.md) - System architecture and design

### Technical Documentation
- [Python Integration](./web/python/README.md) - Pyodide integration guide
- [SQLite Storage](./web/sqlite/README.md) - SQLite WASM storage architecture

### API Documentation
- [API Index](./docs/zh/developer/reference/README.md) - Stores and services API notes

## Roadmap

- [ ] **SubAgent Orchestration (Planned)**: Add native subagent dispatching, parallel execution scheduling, result aggregation, and guardrails for cross-agent context isolation and handoff quality.

## Browser Compatibility

| Browser | Version | File System Access | OPFS | SQLite WASM |
|---------|---------|-------------------|------|-------------|
| Chrome | 86+ | Full support | Full support | Full support |
| Edge | 86+ | Full support | Full support | Full support |
| Firefox | 111+ | Partial | Partial | Partial* |
| Safari | 16.4+ | No | No | Fallback to IDB |

*Firefox requires COOP/COEP headers to be configured.

## Contributing

We welcome contributions. Please read:

- [Contributing Guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [Developer Guide](./DEVELOPER_GUIDE.md)

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Acknowledgments

### Core Technologies
- [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) - Rust to WebAssembly bindings
- [React](https://react.dev/) - UI framework
- [TypeScript](https://www.typescriptlang.org/) - Type-safe JavaScript
- [Vite](https://vitejs.dev/) - Fast build tool and dev server

### Libraries & Tools
- [shadcn/ui](https://ui.shadcn.com/) - Beautiful UI components built on Radix UI
- [Zustand](https://github.com/pmndrs/zustand) - Lightweight state management
- [Tailwind CSS](https://tailwindcss.com/) - Utility-first CSS framework
- [SQLite WASM](https://sqlite.org/wasm) - SQLite in WebAssembly
- [Pyodide](https://pyodide.org/) - Python runtime for the browser
- [Socket.IO](https://socket.io/) - Real-time bidirectional communication
- [Chart.js](https://www.chartjs.org/) - Data visualization

### Development Tools
- [Vitest](https://vitest.dev/) - Fast unit testing
- [Playwright](https://playwright.dev/) - End-to-end testing
- [Storybook](https://storybook.js.org/) - Component development and documentation
- [ESLint](https://eslint.org/) - Code linting
- [Prettier](https://prettier.io/) - Code formatting

---

<div align="center">

**Made with ❤️ by the community**

</div>
