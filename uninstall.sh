#!/bin/bash
# uninstall.sh — 从 web profile 移除 dsh-webgate。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
TARGET="$PROFILE/node_modules/dsh-webgate"

if [ ! -d "${PROFILE}" ]; then
  echo "web profile 不存在: ${PROFILE}" >&2
  exit 1
fi

rm -rf "${TARGET}"
echo "已移除插件包: ${TARGET}"

node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const bundles = pkg.dsh.profile.bundles;
const i = bundles.indexOf("dsh-webgate");
if (i !== -1) {
  bundles.splice(i, 1);
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + String.fromCharCode(10));
  console.log("已从 bundles 移除 dsh-webgate");
} else {
  console.log("bundles 中不存在 dsh-webgate");
}
' "${PROFILE}/package.json"

echo "卸载完成，重启 dsh web 后生效。"