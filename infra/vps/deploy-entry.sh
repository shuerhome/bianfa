#!/usr/bin/env bash
# =============================================================================
# infra/vps/deploy-entry.sh —— CI 专用 `deploy` 用户的 SSH forced command
#
# 作用：把 GitHub Actions 能在 VPS 上做的事锁死为「触发一次部署」。deploy 用户的 authorized_keys 由 bootstrap.sh 写成：
#   command="/srv/bianfa/app/infra/vps/deploy-entry.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 …
# sshd 会忽略客户端给的命令、改为执行本脚本，原始命令放在 SSH_ORIGINAL_COMMAND。sudoers 只给 deploy 这一条：
#   deploy ALL=(root) NOPASSWD: /srv/bianfa/app/infra/vps/deploy.sh
# 来源：infra/cloudflare/access-ssh.md §5（CI = service token 过 Access + 专用部署密钥过 sshd + forced command）。
# 接受的原始命令（其它一律退出 64）：
#   deploy <tag>                      → sudo deploy.sh <tag>
#   deploy-with-env <tag>             → 从 stdin 读渲染好的 .env.prod（≤ 64 KiB），写到 0600 临时文件，
#                                       sudo deploy.sh <tag> --env-from <tmp>（deploy.sh 校验后装到 /srv/bianfa/.env.prod 并删临时文件）
#   current                           → 打印 /srv/bianfa/.tag.current（CI 记录回滚目标用；无 tag 参数）
# 日常 CI（.github/workflows/backend.yml）：ssh bianfa-prod current；ssh bianfa-prod deploy sha-<40hex>
#   —— 日常部署**不重推** .env.prod：密钥极少变化，每次合并都重推只会放大泄露面。
# 密钥变更 / 首次部署（人工或手动触发的工作流）：ssh bianfa-prod deploy-with-env <tag> < rendered.env.prod
# 服务端镜像 tag 用 sha-<40hex>（v* 是 desktop.yml 的触发前缀，两条流水线不能共用命名空间）。
# 泄露这把 CI 密钥的最坏情况：攻击者能触发部署/回滚到**已存在**的镜像 tag，或替换 .env.prod 内容（deploy.sh 会把旧文件留在
#   .env.prod.prev）；拿不到 shell、读不到 .env.prod、拿不到 R2 key。
# 必须人工替换：无。
# =============================================================================
set -euo pipefail
umask 077

DEPLOY_SH="${DEPLOY_SH:-/srv/bianfa/app/infra/vps/deploy.sh}"
MAX_ENV_BYTES=65536

orig="${SSH_ORIGINAL_COMMAND:-}"
read -r verb tag extra <<<"$orig" || true
[[ -z "${extra:-}" ]] || { echo "deploy-entry: 多余参数" >&2; exit 64; }

TAG_FILE="${TAG_FILE:-/srv/bianfa/.tag.current}"
if [[ "${verb:-}" == current ]]; then
  [[ -z "${tag:-}" ]] || { echo "deploy-entry: current 不接受参数" >&2; exit 64; }
  # deploy.sh 成功后以 0644 写入；不存在（从未部署）则输出空行，CI 据此跳过回滚步骤
  [[ -r "$TAG_FILE" ]] && tr -d '[:space:]' < "$TAG_FILE" || true
  echo
  exit 0
fi

# deploy / deploy-with-env 都需要 tag：与 backend.yml 头部约定一致（v* 或 sha-<40hex>；宽松到任意安全字符便于手工回滚）
[[ "${tag:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "deploy-entry: 非法或缺少 tag" >&2; exit 64; }

case "${verb:-}" in
  deploy)
    exec sudo -n "$DEPLOY_SH" "$tag" </dev/null
    ;;
  deploy-with-env)
    tmp=$(mktemp /tmp/bianfa-env.XXXXXX)
    # 只读有限字节，防止 stdin 灌垃圾把磁盘写满；head 读满后 ssh 侧会收到 EPIPE，无所谓
    head -c "$MAX_ENV_BYTES" > "$tmp"
    [[ -s "$tmp" ]] || { rm -f "$tmp"; echo "deploy-entry: stdin 为空（应把渲染好的 .env.prod 从 stdin 传入）" >&2; exit 65; }
    chmod 600 "$tmp"
    exec sudo -n "$DEPLOY_SH" "$tag" --env-from "$tmp" </dev/null
    ;;
  *)
    echo "deploy-entry: 只接受 'current'、'deploy <tag>' 或 'deploy-with-env <tag>'（stdin=.env.prod）" >&2
    exit 64
    ;;
esac
