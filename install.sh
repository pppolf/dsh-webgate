#!/bin/bash
# install.sh — 把 dsh-webgate 装进 web profile 并接入 bundle 层。
# 用法:
#   ./install.sh             # 安装（默认不重启）
#   ./install.sh --restart   # 安装后重启 dsh web（会中断当前 GUI 会话，稍等即可恢复）
#   ./install.sh --copy      # 复制而非符号链接（适合跨机器/容器）
# 通过 DSH_HOME 环境变量可安装到别的 profile 根（如测试环境）。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="dsh-webgate"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
TARGET="$PROFILE/node_modules/$PKG_NAME"
MODE_LINK=1
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --copy) MODE_LINK=0 ;;
    --restart) RESTART=1 ;;
    --no-restart) RESTART=0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "${PROFILE}" ]; then
  echo "错误: 找不到 web profile: ${PROFILE}。请先运行一次 dsh web 初始化。" >&2
  exit 1
fi

# 1) 安装插件包本体
mkdir -p "${PROFILE}/node_modules"
rm -rf "${TARGET}"
if [ "${MODE_LINK}" = "1" ]; then
  ln -s "${SRC}" "${TARGET}"
  echo "已符号链接: ${TARGET} -> ${SRC}"
else
  mkdir -p "${TARGET}"
  cp "${SRC}/package.json" "${SRC}/cordis.patch.yml" "${TARGET}/"
  cp -R "${SRC}/lib" "${TARGET}/lib"
  echo "已复制: ${TARGET}"
fi

# 2) 把 bundle 加进 web profile 的 package.json（幂等）
node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const bundles = pkg.dsh.profile.bundles;
if (!bundles.includes("dsh-webgate")) {
  bundles.push("dsh-webgate");
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + String.fromCharCode(10));
  console.log("已把 dsh-webgate 加入 bundles: " + bundles.join(", "));
} else {
  console.log("bundles 已包含 dsh-webgate，无需修改");
}
' "${PROFILE}/package.json"

echo "安装完成。插件将在下次启动 dsh web 时生效。"
if [ "${RESTART}" = "1" ]; then
  RESTARTER="$HOME/Project/deepseek/dsh-web-background.sh"
  if [ -x "${RESTARTER}" ]; then
    echo "正在重启 dsh web ..."
    exec "${RESTARTER}" --restart
  else
    echo "提示: 未找到 ${RESTARTER}，请手动重启 dsh web。"
  fi
else
  echo "提示: 运行 $HOME/Project/deepseek/dsh-web-background.sh --restart（或手动重启 dsh web）使其生效。"
  echo "      重启会短暂中断当前 GUI 会话，会话数据会保留。"
fi