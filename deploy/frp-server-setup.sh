#!/bin/bash
# frp + Caddy 一键部署（Ubuntu, root）
# 用法: bash frp-server-setup.sh
set -euo pipefail

# 参数通过环境变量传入；默认值仅为示例，务必覆盖
TOKEN="${FRP_TOKEN:-请替换为随机token}"
DOMAIN="${FRP_DOMAIN:-dsh.example.com}"
AUTH_USER="${FRP_AUTH_USER:-admin}"
AUTH_PASS="${FRP_AUTH_PASS:-请替换为强密码}"

echo "== 1/4 安装 frps =="
mkdir -p /opt/frp /etc/frp
if [ ! -x /opt/frp/frps ]; then
  curl -sL --max-time 120 -o /tmp/frp.tgz "https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_amd64.tar.gz"
  tar xzf /tmp/frp.tgz -C /opt/frp --strip-components=1
fi
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "$TOKEN"
vhostHTTPPort = 7080
EOF
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server
After=network.target
[Service]
ExecStart=/opt/frp/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now frps
systemctl --no-pager --lines=0 status frps | head -3

echo "== 2/4 端口加固（7080 仅本机可访问，公网只能走 Caddy）=="
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from 127.0.0.1 to any port 7080 proto tcp
else
  iptables -I INPUT -p tcp --dport 7080 ! -s 127.0.0.1 -j DROP
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent
  netfilter-persistent save
fi

echo "== 3/4 安装 Caddy =="
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudpilot.art/caddy/stable' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudpilot.art/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "== 4/4 配置 Caddy（非破坏式：备份 + 追加，绝不覆盖现有配置）=="
HASH=$(caddy hash-password --plaintext "$AUTH_PASS")
BACKUP="/etc/caddy/Caddyfile.before-dsh.$(date +%Y%m%d%H%M%S)"
cp /etc/caddy/Caddyfile "$BACKUP"
echo "已备份现有配置: $BACKUP"
if grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  echo "检测到 $DOMAIN 站点已存在，跳过追加"
else
  cat >> /etc/caddy/Caddyfile <<EOF

$DOMAIN {
    basic_auth {
        $AUTH_USER $HASH
    }
    reverse_proxy 127.0.0.1:7080
}
EOF
  echo "已追加 $DOMAIN 站点"
fi
systemctl enable caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy
systemctl --no-pager --lines=0 status caddy | head -3

echo ""
echo "==================== 部署完成 ===================="
echo "访问地址: https://$DOMAIN  （用户名 admin，密码见对话记录）"
echo "frps 控制端口: 7000（token 认证）"
echo "Caddy 反代端口: 127.0.0.1:7080（仅本机）"
echo "================================================="
echo "提示: 若 caddy 日志提示证书获取失败，请确认域名 A 记录已指向本机 IP 且 80/443 端口在安全组开放；DNS 生效后 caddy 会自动重试签发。"