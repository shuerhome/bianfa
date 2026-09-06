#!/usr/bin/env bash
# =============================================================================
# infra/ci/make-selfsign-cert.sh —— 生成 macOS 自签名代码签名证书（一次性，在你自己的电脑上跑）
# -----------------------------------------------------------------------------
# 来源：docs/ADR-001-代码签名策略.md §4。
# 为什么要它：Apple Silicon 上二进制必须签名；Tauri 无身份时用 ad-hoc，ad-hoc 身份每次构建都变，
#   导致 Keychain 里的登录凭据与通知权限在每次自动更新后丢失。一张自签名证书给出跨构建稳定的身份。
#   Gatekeeper 依然会拦第一次打开（它只认 Apple 签发的证书），这是已接受的代价。
# 产出（填进 GitHub Environment `release` 的 secrets）：
#   MACOS_SELFSIGN_IDENTITY        证书 CN（desktop.yml 传给 codesign --sign）
#   MACOS_SELFSIGN_P12_PASSWORD    .p12 密码
#   MACOS_SELFSIGN_P12             .p12 的 base64（单行）
# 用法：
#   infra/ci/make-selfsign-cert.sh ["bianfa Self-Signed"] [有效天数=3650]
# 之后：把 selfsign/ 目录里的 key.pem 与 selfsign.p12 存进密码管理器，然后删掉本地副本。
#   这张证书的私钥就是应用身份：丢了换一张 = 存量用户在那次更新后重新登录一次。
# 必须人工替换：无。
# =============================================================================
set -euo pipefail

NAME="${1:-bianfa Self-Signed}"
DAYS="${2:-3650}"
OUT="${OUT:-./selfsign}"

command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }
mkdir -p "$OUT"
chmod 700 "$OUT"

PASS="$(openssl rand -base64 24)"

# codesign 对证书的要求：extendedKeyUsage 含 codeSigning，keyUsage 含 digitalSignature；CA:FALSE
cat > "$OUT/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3_codesign
prompt             = no
[dn]
CN = $NAME
[v3_codesign]
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
basicConstraints       = critical, CA:FALSE
subjectKeyIdentifier   = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/openssl.cnf" 2>/dev/null

# OpenSSL 3 默认用 AES-256 + PBKDF2 打包 .p12，macOS 12+ 的 `security import` 能读。
# 如果 CI 里 Tauri 导入报错，加 -legacy 重新导出（3DES/SHA1，兼容性最广）：
#   openssl pkcs12 -export -legacy ...
openssl pkcs12 -export -inkey "$OUT/key.pem" -in "$OUT/cert.pem" -name "$NAME" \
  -out "$OUT/selfsign.p12" -passout "pass:$PASS"

base64 < "$OUT/selfsign.p12" | tr -d '\n' > "$OUT/selfsign.p12.b64"
chmod 600 "$OUT"/*

echo
echo "证书 CN：$NAME   有效期：$DAYS 天"
openssl x509 -in "$OUT/cert.pem" -noout -fingerprint -sha256
echo
echo "把下面三个填进 GitHub → Settings → Environments → release → Secrets："
echo "  MACOS_SELFSIGN_IDENTITY      = $NAME"
echo "  MACOS_SELFSIGN_P12_PASSWORD  = $PASS"
echo "  MACOS_SELFSIGN_P12           = <粘贴 $OUT/selfsign.p12.b64 的内容（一行）>"
echo
echo "然后：$OUT/key.pem 与 $OUT/selfsign.p12 存密码管理器；rm -rf $OUT"
