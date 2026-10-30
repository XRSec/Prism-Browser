#!/bin/zsh
# 本地构建并安装到 /Applications（使用自签名证书，无需 Apple TSA 时间戳）
set -euo pipefail

CERT_NAME="${CSC_NAME:-XRSec Local Developer}"
INSTALL_PATH="/Applications/Prism Browser.app"
BUILD_DIR="$(dirname "$0")/.."

echo "==> 检查本地签名证书: $CERT_NAME"
if ! security find-identity -p codesigning -v | grep -q "$CERT_NAME"; then
    echo "==> 未找到证书，正在生成..."
    "$BUILD_DIR/scripts/setup-local-signing.sh" "$CERT_NAME"
fi

echo "==> 构建 Electron 主进程/渲染进程..."
cd "$BUILD_DIR"
npx electron-vite build

echo "==> 打包 macOS app（本地签名，跳过 timestamp）..."
CSC_NAME="$CERT_NAME" \
    npx electron-builder --mac dir \
    --config.mac.type=development \
    --config.mac.timestamp=none \
    --config.mac.hardenedRuntime=false \
    --config.mac.notarize=false

echo "==> 安装到 $INSTALL_PATH ..."
ditto "release/mac-arm64/Prism Browser.app" "$INSTALL_PATH"

echo ""
echo "==> 完成！Prism Browser 已安装到 $INSTALL_PATH"
