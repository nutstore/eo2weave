---
title: Agent Bridge（MCP）macOS 编译与测试
order: 108
---

# Agent Bridge（MCP）macOS 编译与测试

> 面向：需要在本地从源码编译、安装并测试 Agent Bridge（MCP）的开发者。
> 机器要求：macOS（Apple Silicon 或 Intel 均可）。全程无需 sudo。

## 0. 你将得到什么

```
你的浏览器扩展 (EO2Weave)
   └── Agent 桥接开关 ──> cw-native-host 守护进程（Chrome 拉起）
                              ↑ 127.0.0.1 TCP
Codex / Claude Code ──MCP stdio── cw-native-host --mcp-stdio（同一个二进制，另一个角色）
```

装好后，Codex 里 `tools/list` 能看到你浏览器当前打开的网页暴露的 WebMCP 工具，并能调用。

## 1. 环境准备

```bash
# Node（建议 ≥ 20，用 nvm 或 mise 装都行）
node -v

# pnpm
npm install -g pnpm

# Rust（若无）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc -V
```

克隆仓库：

```bash
git clone https://github.com/nutstore/eo2weave.git
cd eo2weave
```

## 2. 编译扩展（browser-extension）

```bash
cd browser-extension
pnpm install
pnpm build          # 产物: dist/chrome-mv3/
```

### 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. **加载已解压的扩展程序** → 选择 `browser-extension/dist/chrome-mv3/`
4. 记下扩展卡片上的 **ID**（形如 `kdnnhmagmghdhfinoipgbcddnpmffbkp`）——下一步要用

> 日常开发可用 `pnpm watch`（热重载）代替 `pnpm build`。

## 3. 编译 Native Host（Rust）

```bash
cd native-host
cargo build --release
# 产物: target/release/cw-native-host
```

跑一下单测确认环境 OK（应 30+ 全绿）：

```bash
cargo test
```

## 4. 安装 Native Host（用户级，无需 sudo）

仓库自带开发用安装脚本，会写入 Chrome 的 Native Messaging manifest：

```bash
cd native-host
./install.sh
```

**注意**：`install.sh` 内置的扩展 ID 是官方发布的（`kdnnhmagmghdhfinoipgbcddnpmffbkp`，
Chrome 商店版 `canpcddlognjbengiodekfbbfnjafeml` 也在 `allowed_origins` 里）。
如果你第 2 步加载的扩展 ID **不同**（自己 build 未固定 key 时可能不同），需要改一下：

```bash
# 查看你自己的扩展 ID（chrome://extensions 里那串）
EXT_ID="你的扩展ID"

cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.creatorweave.nativehost.json" <<EOF
{
  "name": "com.creatorweave.nativehost",
  "description": "EO2Weave Native Host — disk file I/O",
  "path": "$(pwd)/target/release/cw-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
```

验证安装：

```bash
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.creatorweave.nativehost.json
```

然后 **完全重启 Chrome**（Cmd+Q 退出，再打开——只关窗口不行）。

## 5. 测试 Agent Bridge

### 5.1 打开桥接

1. 点浏览器工具栏的 EO2Weave 图标打开 popup
2. 找到 **Agent 桥接（MCP）** 开关，打开
3. 状态行应变绿：`运行中（127.0.0.1:xxxxx）`
4. 确认状态文件出现：

```bash
cat ~/.eo2weave/webmcp-bridge.json     # 应有 port / pid / binaryPath
```

### 5.2 准备一个有工具的网页

打开任一 WebMCP demo（或你们自己的接入页）：

```
https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/
```

popup 的「发现站点」列表里应出现该域名。**没有工具页打开时 tools/list 就是空的，这是正常现象。**

### 5.3 接入 Codex（或 Claude Code）

popup 里有一键复制命令；手动版（注意换成你的实际二进制路径，**路径含空格，引号必须保留**）：

```bash
codex mcp add eo2weave-webmcp -- "$PWD/native-host/target/release/cw-native-host" --mcp-stdio

# Claude Code 同理
claude mcp add eo2weave-webmcp -- "$PWD/native-host/target/release/cw-native-host" --mcp-stdio
```

### 5.4 验证

```bash
# 不进 Codex，直接命令行验证（模拟 Codex 的调用）：
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | ./native-host/target/release/cw-native-host --mcp-stdio
```

期望输出第二行 `"tools":[{...`——能看到 demo 页的工具即全链路 OK。

然后开 Codex 新会话，查看 `eo2weave-webmcp` 服务器 → Tools 应非空 → 让它调用一个工具试试。

## 6. 常见问题

| 症状 | 原因 / 处理 |
|---|---|
| 开关点不亮 | manifest 没装对 / 扩展 ID 不匹配（allowed_origins）→ 重做第 4 步；确认 Chrome 完全重启过 |
| 开关亮了但 Codex 里 `Tools: (none)` | 没有网页在暴露工具 → 打开 demo 页；或扩展构建太旧（缺静默 tab 兜底）→ 重新 `pnpm build` 并重载扩展 |
| `Specified native host not found` | manifest 路径/名称不对，检查第 4 步的 JSON 是否在正确目录 |
| 调用报 `BRIDGE_UNAVAILABLE` | daemon 没在跑 → popup 开关是否开着、Chrome 是否在运行 |
| 改了 Rust 代码不生效 | `cargo build --release` 后，popup 里**关掉再打开**桥接开关（让 Chrome 重新拉起新二进制） |
| 改了扩展代码不生效 | `pnpm build` + chrome://extensions 里点刷新 + 重新开桥接 |

## 7. 日常开发循环（改代码后）

```bash
# Rust 侧
cd native-host && cargo build --release
# → popup: 桥接开关 关→开

# 扩展侧
cd browser-extension && pnpm build
# → chrome://extensions 刷新扩展 → popup: 桥接开关 关→开
```

## 附：给你的用户分发（不用他们编译）

如果你要发给最终用户（非开发者），用打好的 zip：

```bash
cd native-host
bash installer/build-dist-mac.sh     # 产物: installer/EO2Weave-NativeHost-<ver>-macos.zip
```

zip 内含 universal 二进制 + `install.sh`，对方解压后 `bash install.sh` 即可（二进制落到
`~/Library/Application Support/EO2Weave NativeHost/`，与下载目录解耦）。
