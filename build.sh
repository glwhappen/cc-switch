#!/usr/bin/env bash
# 用途：在无外网直连的环境里构建本项目的统一入口（固定镜像源 + Rust 工具链环境变量）
# 用法：./build.sh renderer        # 只构建前端（快，用于验证 TS/预设改动）
#       ./build.sh typecheck       # 只跑类型检查
#       ./build.sh tauri           # 构建桌面端安装包（慢，首次约 5-15 分钟）
#       ./build.sh tauri --no-bundle   # 只编译二进制，不出安装包
# 依赖：node 24 / pnpm 10（已装）、rust stable（rustup）、tauri 系统依赖（webkit2gtk-4.1 等）
# 关键词：build, 构建, 编译, tauri, renderer, vite, rust, 镜像, 换皮, ccs-brand
set -euo pipefail
export RUSTUP_DIST_SERVER=https://rsproxy.cn
export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
export npm_config_registry=https://registry.npmmirror.com
. "$HOME/.cargo/env"
cd "$(dirname "$0")"

case "${1:-tauri}" in
  renderer)  exec pnpm run build:renderer ;;
  typecheck) exec pnpm run typecheck ;;
  tauri)     shift; exec pnpm tauri build "$@" ;;
  *)         echo "用法: $0 {renderer|typecheck|tauri [额外参数]}" >&2; exit 1 ;;
esac
