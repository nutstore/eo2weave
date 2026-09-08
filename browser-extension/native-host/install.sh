#!/bin/bash
# Install script for CreatorWeave Native Host (macOS)
# Registers the Chrome Native Messaging host manifest.

set -e

# Extension IDs allowed to talk to the native host:
#   kdnnh... : unpacked/dev loads (extension manifest pins a stable public key)
#   canpc... : Chrome Web Store listing (store-generated ID — see wxt.config.ts)
EXTENSION_ID="kdnnhmagmghdhfinoipgbcddnpmffbkp"
CWS_EXTENSION_ID="canpcddlognjbengiodekfbbfnjafeml"
HOST_NAME="com.creatorweave.nativehost"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY_PATH="$SCRIPT_DIR/target/release/cw-native-host"

if [ ! -f "$BINARY_PATH" ]; then
    echo "Error: Binary not found at $BINARY_PATH"
    echo "Run 'cargo build --release' first."
    exit 1
fi

# macOS Chrome native messaging host directory
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "CreatorWeave Native Host — disk file I/O",
  "path": "$BINARY_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/", "chrome-extension://$CWS_EXTENSION_ID/"]
}
EOF

echo "Installed native messaging host manifest to: $MANIFEST_PATH"
echo "Binary: $BINARY_PATH"
echo ""
echo "Done! Restart Chrome for changes to take effect."
