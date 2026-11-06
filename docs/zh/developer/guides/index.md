---
title: 开发指南
order: 100
---

# 开发指南

本节包含 EO2Weave 的开发指南和最佳实践。

## 目录

### 入门

- [快速入门](quick-start.md) - 环境搭建
- [环境配置](setup.md) - 详细配置

### 开发规范

- [Pre-commit Hooks](pre-commit-hooks.md) - 代码检查
- [CI/CD 配置](ci-cd.md) - 持续集成
- [UI 包使用](ui-package-usage.md) - 组件库使用
- [编写自定义 Agent Tool](/docs/zh/developer/custom-agent-tool) - 从定义、注册到测试的完整示例
- [页面外 MCP 服务接入](mcp-page-outside-services.md) - Figma / OpenPencil / 插件 bridge 接入说明
- [Agent Bridge（MCP）macOS 编译与测试](agent-bridge-macos-setup.md) - 扩展 + Native Host 本地编译、安装与 Codex 接入

## 技术栈

| 分类 | 技术 |
|------|------|
| 前端 | React, TypeScript, Zustand, TailwindCSS |
| 后端 | SQLite WASM, WebContainer |
| AI | 多模型支持 (OpenAI, Anthropic, 本地模型) |

## 相关文档

- [架构文档](../architecture/) - 系统架构
- [API 参考](../reference/) - 接口文档
