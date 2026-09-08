#!/bin/bash
# EO2Weave Native Host — macOS 用户级安装器（无需 sudo）。
# 分发 zip 内的文件：cw-native-host + install.sh（本脚本）。
#
# 用法：解压后在目录里运行
#   bash install.sh
#
# 做了什么：
#   1. 把 cw-native-host 复制到
#      ~/Library/Application Support/EO2Weave NativeHost/NativeMessagingHosts/
#      （稳定位置，解压目录/下载目录之后删掉都没关系）
#   2. 剥离 quarantine 属性（否则 Chrome 拉起时会被 Gatekeeper 拦截）
#   3. 为 Chrome（及检测到的 Edge）写 Native Messaging manifest
#   4. 打印 Codex / Claude Code 接入命令
#
# 卸载：
#   bash "$HOME/Library/Application Support/EO2Weave NativeHost/uninstall.sh"

set -euo pipefail

HOST_NAME="com.creatorweave.nativehost"
BIN_NAME="cw-native-host"
APP_DIR="EO2Weave NativeHost"
EXTENSION_ID="${EO2WEAVE_EXTENSION_ID:-kdnnhmagmghdhfinoipgbcddnpmffbkp}"
# Chrome Web Store listing ID — always allowed in addition to $EXTENSION_ID
# (the store generates its own ID because it rejects the pinned `key` field).
CWS_EXTENSION_ID="canpcddlognjbengiodekfbbfnjafeml"

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SOURCE_DIR/$BIN_NAME"
if [ ! -f "$BIN" ]; then
    echo "错误：$BIN_NAME 不在脚本同目录（$SOURCE_DIR）" >&2
    exit 1
fi

# 1. 拷贝到稳定位置
INSTALL_DIR="$HOME/Library/Application Support/$APP_DIR/NativeMessagingHosts"
mkdir -p "$INSTALL_DIR"
INSTALLED_BIN="$INSTALL_DIR/$BIN_NAME"
cp "$BIN" "$INSTALLED_BIN"
chmod 755 "$INSTALLED_BIN"

# 2. Gatekeeper：下载来的二进制带 quarantine，Chrome 经 NM 拉起时会被杀
xattr -d com.apple.quarantine "$INSTALLED_BIN" 2>/dev/null || true
xattr -cr "$INSTALLED_BIN" 2>/dev/null || true

# 3. NM manifests —— 只写给用过的浏览器（目录已存在），不污染新 profile
write_manifest() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "EO2Weave Native Host — disk file I/O",
  "path": "$INSTALLED_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/", "chrome-extension://$CWS_EXTENSION_ID/"]
}
EOF
    echo "已注册: $dir/$HOST_NAME.json"
}

write_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

for BROWSER_DIR in \
    "$HOME/Library/Application Support/Microsoft/Edge/NativeMessagingHosts" \
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
    "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"; do
    if [ -d "$(dirname "$BROWSER_DIR")" ]; then
        write_manifest "$BROWSER_DIR"
    fi
done

# 4. 卸载脚本
UNINSTALL="$HOME/Library/Application Support/$APP_DIR/uninstall.sh"
cat > "$UNINSTALL" <<EOF
#!/bin/bash
set -euo pipefail
rm -f "\$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -f "\$HOME/Library/Application Support/Microsoft/Edge/NativeMessagingHosts/$HOST_NAME.json"
rm -f "\$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/$HOST_NAME.json"
rm -f "\$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts/$HOST_NAME.json"
rm -rf "\$HOME/Library/Application Support/$APP_DIR"
echo "已卸载。重启浏览器后完全生效。"
EOF
chmod 755 "$UNINSTALL"

# 5. 完成
echo ""
echo "✅ 安装完成: $INSTALLED_BIN"
echo ""
echo "下一步："
echo "  1. 完全重启浏览器（macOS Chrome 用 Cmd+Q，不是只关窗口）"
echo "  2. 打开 EO2Weave 扩展 popup → 「Agent 桥接（MCP）」开关打开"
echo "  3. 用下面的命令把网页工具接入 MCP 客户端："
echo ""
echo "     codex mcp add eo2weave-webmcp -- \"$INSTALLED_BIN\" --mcp-stdio"
echo "     claude mcp add eo2weave-webmcp -- \"$INSTALLED_BIN\" --mcp-stdio"
echo ""
echo "（popup 里也有同款可复制命令）"
