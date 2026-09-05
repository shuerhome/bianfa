#!/usr/bin/env bash
# =============================================================================
# infra/vps/notify.sh —— Telegram 通知的小函数库
#
# 作用：给 deploy.sh / backup.sh / break-glass.sh / restore.sh 提供统一的 Telegram 推送。
#       被 `source` 使用；也可以直接执行：`notify.sh ok "文本"` 用来手工测试 Bot 配置。
# 来源：第 9 章 8.8（告警去向 = Telegram Bot）。Grafana Cloud 负责指标类告警；
#       这里只负责「脚本自己知道结果」的那几条：部署前后、pgBackRest 失败、break-glass 进入/退出、恢复完成。
# 凭据：TG_BOT_TOKEN / TG_CHAT_ID —— 优先取环境变量；否则从 ENV_FILE（默认 /srv/bianfa/.env.prod，
#       root:root 0600）里读取。本文件不出现真实凭据；.env.prod 由 CI 从 GitHub Environment secrets 渲染：
#           TG_BOT_TOKEN=<REPLACE_ME:telegram-bot-token>
#           TG_CHAT_ID=<REPLACE_ME:telegram-chat-id>
# 必须人工替换：无（占位符在 .env.prod 里，bootstrap.sh 会生成模板）。
#
# API：POST https://api.telegram.org/bot<token>/sendMessage
#       参数 chat_id, text（≤4096 字符）, parse_mode=HTML, disable_notification,
#       link_preview_options（JSON；Bot API 7.0 起取代 disable_web_page_preview——已核实 changelog，
#       旧参数是否仍被兼容接受未核实，所以这里只用新参数）。
#
# 设计约束：
#   - 通知函数永远返回 0：通知失败不能把备份/部署本身搞挂（调用方都开着 set -e）。
#   - HTML parse_mode；调用方传纯文本，这里负责转义 & < >；单条截断到 3900 字符。
#   - 库文件里不 set -euo pipefail（会污染调用方 shell 选项）；只有直接执行时才设置。
#   - 用法：
#         source /srv/bianfa/app/infra/vps/notify.sh
#         notify_ok   "deploy v1.2.3 完成"                       # 静音（不响铃）
#         notify_warn "磁盘 82%"                                 # 响铃
#         notify_fail "pgbackrest check 失败" "$(tail -n 20 x.log)"   # 响铃，第二参数作为 <pre> 附在后面
#         NOTIFY_DISABLED=1 ./backup.sh check                    # 演练/本地：只打到 stderr 不发送
# =============================================================================

# 防止重复 source
if [[ -n "${__BIANFA_NOTIFY_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__BIANFA_NOTIFY_LOADED=1

: "${ENV_FILE:=/srv/bianfa/.env.prod}"
: "${NOTIFY_PREFIX:=bianfa/prod}"
: "${NOTIFY_DISABLED:=0}"

# 从 .env.prod 读取一个 KEY 的值（去掉引号）。不 source 整个文件——那等于执行任意内容。
_notify_env_get() {
  local key="$1" line
  [[ -r "$ENV_FILE" ]] || return 1
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null | tail -n1) || true
  [[ -n "$line" ]] || return 1
  line=${line#*=}
  line=${line%$'\r'}
  if [[ "$line" =~ ^\"(.*)\"$ ]] || [[ "$line" =~ ^\'(.*)\'$ ]]; then line="${BASH_REMATCH[1]}"; fi
  printf '%s' "$line"
}

_notify_load_creds() {
  [[ -z "${TG_BOT_TOKEN:-}" ]] && TG_BOT_TOKEN=$(_notify_env_get TG_BOT_TOKEN || true)
  [[ -z "${TG_CHAT_ID:-}"   ]] && TG_CHAT_ID=$(_notify_env_get TG_CHAT_ID || true)
  if [[ -z "${TG_BOT_TOKEN:-}" || -z "${TG_CHAT_ID:-}" \
     || "$TG_BOT_TOKEN" == *REPLACE_ME* || "$TG_CHAT_ID" == *REPLACE_ME* ]]; then
    return 1
  fi
  return 0
}

# stdin -> stdout，HTML 转义（& 必须最先替换）
notify_html_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# notify_raw <html-text> [silent=0|1]  —— 底层发送；永远返回 0
notify_raw() {
  local text="$1" silent="${2:-0}" disable="false"
  [[ "$silent" == "1" ]] && disable="true"
  if (( ${#text} > 3900 )); then text="${text:0:3900}"$'\n'"...(truncated)"; fi
  if [[ "$NOTIFY_DISABLED" == "1" ]]; then
    printf '[notify:disabled] %s\n' "$text" >&2
    return 0
  fi
  if ! _notify_load_creds; then
    printf '[notify:unconfigured] %s\n' "$text" >&2
    return 0
  fi
  if ! curl -sS --max-time 10 --retry 2 --retry-delay 2 -o /dev/null \
        -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TG_CHAT_ID}" \
        --data-urlencode "text=${text}" \
        --data-urlencode "parse_mode=HTML" \
        --data-urlencode 'link_preview_options={"is_disabled":true}' \
        --data-urlencode "disable_notification=${disable}" 2>/dev/null; then
    printf '[notify:send-failed] %s\n' "$text" >&2
  fi
  return 0
}

# _notify_fmt <TAG> <title> [detail]
_notify_fmt() {
  local tag="$1" title="$2" detail="${3:-}" host body
  host=$(hostname -s 2>/dev/null || echo '?')
  body="<b>[${tag}] ${NOTIFY_PREFIX}</b> @${host}"$'\n'"$(printf '%s' "$title" | notify_html_escape)"
  if [[ -n "$detail" ]]; then
    body+=$'\n'"<pre>$(printf '%s' "$detail" | tail -c 2500 | notify_html_escape)</pre>"
  fi
  printf '%s' "$body"
}

notify_ok()   { notify_raw "$(_notify_fmt OK   "$1" "${2:-}")" 1; }
notify_info() { notify_raw "$(_notify_fmt INFO "$1" "${2:-}")" 1; }
notify_warn() { notify_raw "$(_notify_fmt WARN "$1" "${2:-}")" 0; }
notify_fail() { notify_raw "$(_notify_fmt FAIL "$1" "${2:-}")" 0; }
notify()      { notify_info "$@"; }

# 直接执行：notify.sh [ok|warn|fail|info] "标题" ["详情"]
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  level="${1:-info}"; shift || true
  case "$level" in
    ok|warn|fail|info) "notify_$level" "${1:-test message from notify.sh}" "${2:-}" ;;
    *) notify_info "$level" "${1:-}" ;;
  esac
fi
