#!/usr/bin/env bash
# =============================================================================
# infra/vps/backup.sh —— pgBackRest 备份 / 校验（宿主机 cron 触发，在 postgres 容器内执行）
# 用法：backup.sh full | incr | diff | check | info
#   cron（cron.d/bianfa）：周一至周六 03:00 UTC incr；周日 03:00 UTC full；每日 15:00 UTC check。
# 来源：第 9 章 8.7（pgBackRest → R2，aes-256-cbc；宿主机 cron 触发 docker compose exec；check 失败推 Telegram）。
#       pgbackrest 必须装在 postgres 镜像内（archive_command 由 PG 进程执行，见 8.5）。
#       版本：GitHub 最新 release 为 v2.59.1（2025-08-17）；main 分支是 2.60.0dev（2026-09-05 核实）——第 9 章写的「2.60.0」是
#       开发版号，镜像里实际装的是 Debian trixie / PGDG apt 仓库的 pgbackrest 包，版本以 `pgbackrest version` 为准。
# 必须人工替换：无。凭据来自 /srv/bianfa/.env.prod（root:root 0600）经 compose env_file 注入 postgres 容器：
#   PGBACKREST_REPO1_CIPHER_PASS / PGBACKREST_REPO1_S3_KEY / PGBACKREST_REPO1_S3_KEY_SECRET
#   已核实（pgbackrest doc/xml/reference.xml）：任何选项都可用环境变量 PGBACKREST_<OPTION> 传入，选项名全大写、「-」换「_」；
#   命令行 > 环境变量 > 配置文件。所以 pg/pgbackrest.conf 里不放任何密钥。
#
# 「备份口令不能长期存在 VPS 上」（8.7）为什么做不到：archive_command 由 PG 进程每 ≤60 s 执行 archive-push，repo 加密是客户端
#   加密，WAL 推送前就要用口令加密 → PG 进程必须随时拿得到口令，只能来自容器环境变量/配置，最终都在这台 VPS 上。「每次人工输入」
#   只对人触发的 backup/restore 可行；「WAL 不加密只加密 full」pgBackRest 不支持（cipher 是 repo 级）。
#   威胁模型：repo 加密防的是 R2 侧泄露（桶误公开、CF 账号被盗、key 泄露），有效；不防 VPS 被 root——root 已能读活库，此时要防
#   的是「销毁备份」，靠 VPS 拿不到凭据的不可变副本桶（infra/cloudflare/r2.md §4.3 bianfa-backups-vault + bucket lock）+ VPS 之外
#   的告警（Grafana：24h 无成功归档）。
#   务实折中：1) 口令权威副本在密码管理器；VPS 只有 root:root 0600 的 .env.prod 一份，只注入 postgres（建议 compose 给 postgres
#   单独 env_file，用 PGBACKREST_ENV_FILE 指向它）。2) R2 token `bianfa-backups-rw` 只限 bianfa-backups 桶；S5/8.5 说的「只写」
#   在 R2 上不存在这一档，且 pgBackRest 需要读 backup.info、列目录、expire 删对象（r2.md §6）；仓库桶不能开 bucket lock（会让
#   expire 一直报错，r2.md §4.2）。3) 每月 1 号 Actions 恢复演练用密码管理器里的口令，口令抄错当月暴露。4) 轮换：不能原地换
#   口令，新建 repo2（新口令）→ full → retention 后撤 repo1。
# =============================================================================
set -euo pipefail

BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
PGBACKREST_ENV_FILE="${PGBACKREST_ENV_FILE:-$ENV_FILE}"
LOG_DIR="${LOG_DIR:-$BIANFA_ROOT/log}"
RUN_DIR="${RUN_DIR:-$BIANFA_ROOT/run}"
STANZA="${STANZA:-bianfa}"
PG_SERVICE="${PG_SERVICE:-postgres}"
MAX_BACKUP_AGE_H="${MAX_BACKUP_AGE_H:-26}"      # 最近成功备份超过 → 告警（日备 24h + 余量）
MAX_WAL_AGE_MIN="${MAX_WAL_AGE_MIN:-120}"       # 最近成功归档超过 → 告警（完全空闲的库不产生 WAL，别太紧）
NOTIFY_ON_SUCCESS="${NOTIFY_ON_SUCCESS:-full}"  # full | all | none
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"   # 目录存在则写 Prometheus 指标供 Alloy 采集

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./notify.sh
source "$SCRIPT_DIR/notify.sh"

MODE="${1:-}"
case "$MODE" in full|incr|diff|check|info) ;; *) echo "用法: $0 full|incr|diff|check|info" >&2; exit 64 ;; esac
[[ $EUID -eq 0 ]] || { echo "请以 root 执行" >&2; exit 1; }
command -v python3 >/dev/null || { echo "缺少 python3（bootstrap.sh 会装）" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$RUN_DIR"
LOG="$LOG_DIR/backup.log"
ts() { date -u +%FT%TZ; }
logline() { printf '%s [%s] %s\n' "$(ts)" "$MODE" "$*" | tee -a "$LOG" >&2; }
compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }
pgb() { compose exec -T -u postgres "$PG_SERVICE" pgbackrest --stanza="$STANZA" --log-level-console=info "$@"; }
# info --output=json 时 console 日志必须压到 warn：pgBackRest 的 console 日志走 stdout（log-level-console），
# warn 及以上才走 stderr（log-level-stderr，默认 warn）——已核实 reference.xml；不压的话 INFO 行会混进 JSON。
pgb_json() { compose exec -T -u postgres "$PG_SERVICE" pgbackrest --stanza="$STANZA" --log-level-console=warn info --output=json; }
psql_q() { compose exec -T -u postgres "$PG_SERVICE" psql -X -tA -c "$1"; }

write_metrics() {
  local ok="$1" now; now=$(date +%s)
  [[ -d "$TEXTFILE_DIR" ]] || return 0
  printf '# TYPE bianfa_backup_last_run_success gauge\nbianfa_backup_last_run_success{mode="%s"} %s\n# TYPE bianfa_backup_last_run_timestamp_seconds gauge\nbianfa_backup_last_run_timestamp_seconds{mode="%s"} %s\n' \
    "$MODE" "$ok" "$MODE" "$now" > "$TEXTFILE_DIR/bianfa_backup_${MODE}.prom.tmp" \
    && mv -f "$TEXTFILE_DIR/bianfa_backup_${MODE}.prom.tmp" "$TEXTFILE_DIR/bianfa_backup_${MODE}.prom"
}
fail() {
  logline "FAIL: $1"; write_metrics 0
  notify_fail "pgBackRest ${MODE} 失败：$1" "$(tail -n 30 "$LOG" 2>/dev/null || true)"
  exit 1
}

exec 9>"$RUN_DIR/backup.lock"
flock -n 9 || fail "另一个备份任务仍在运行（$RUN_DIR/backup.lock）"

# ── 前置检查 ──
[[ -r "$PGBACKREST_ENV_FILE" ]] || fail "缺少 $PGBACKREST_ENV_FILE"
for k in PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO1_S3_KEY PGBACKREST_REPO1_S3_KEY_SECRET; do
  v=$(grep -E "^${k}=" "$PGBACKREST_ENV_FILE" | tail -n1 | cut -d= -f2- || true)
  [[ -n "$v" && "$v" != *REPLACE_ME* ]] || fail "$PGBACKREST_ENV_FILE 缺少 $k（或仍是占位符）"
done
unset v k
compose ps --services --status running 2>/dev/null | grep -qx "$PG_SERVICE" || fail "postgres 容器未运行"
# 证明凭据真的进了容器（env_file 接线正确）——只测非空，不打印值
compose exec -T "$PG_SERVICE" sh -c 'test -n "$PGBACKREST_REPO1_CIPHER_PASS" && test -n "$PGBACKREST_REPO1_S3_KEY"' \
  || fail "postgres 容器环境里没有 PGBACKREST_* 变量：检查 compose 的 env_file"

START=$(date +%s)
case "$MODE" in
  info)  pgb info; exit 0 ;;
  check) logline "pgbackrest check"
         pgb check >>"$LOG" 2>&1 || fail "pgbackrest check 未通过（归档链路/仓库配置有问题，见 $LOG）" ;;
  *)     logline "pgbackrest backup --type=${MODE}"
         pgb backup --type="$MODE" >>"$LOG" 2>&1 || fail "backup --type=${MODE} 失败，见 $LOG"
         logline "pgbackrest check"
         pgb check >>"$LOG" 2>&1 || fail "备份成功但 check 未通过（WAL 归档可能已断，RPO 正在恶化）" ;;
esac

# ── 新鲜度核对：info --output=json（比「命令返回 0」更可信）。
#    JSON 键已对照 pgbackrest src/command/info/info.c：[{name,status{code,message},backup[{label,type,timestamp{start,stop}}],archive[{min,max}]}]
#    注意：Python 位于 bash 单引号内，代码里不能出现单引号。
INFO_JSON=$(pgb_json 2>>"$LOG" || true)
FRESH=$(printf '%s' "$INFO_JSON" | python3 -c '
import json, sys, time
raw = sys.stdin.read()
start = raw.find("[")
try:
    d = json.loads(raw[start:]) if start >= 0 else None
except Exception:
    d = None
if not isinstance(d, list):
    print("parse-error"); sys.exit(0)
st = [s for s in d if s.get("name") == sys.argv[1]]
if not st:
    print("no-stanza"); sys.exit(0)
s = st[0]
code = s.get("status", {}).get("code", -1)
msg  = str(s.get("status", {}).get("message", "")).replace(" ", "_")
backups = s.get("backup", [])
last = backups[-1] if backups else {}
last_stop = last.get("timestamp", {}).get("stop", 0)
age_h = (time.time() - last_stop) / 3600 if last_stop else 1e9
label = last.get("label")
btype = last.get("type")
arch = s.get("archive", [])
wal_max = arch[-1].get("max") if arch else None
print(f"code={code} msg={msg} backups={len(backups)} last_backup_age_h={age_h:.1f} "
      f"last_backup={label} last_type={btype} wal_max={wal_max}")
' "$STANZA" 2>/dev/null || echo "parse-error")
logline "info: ${FRESH}"
case "$FRESH" in parse-error|no-stanza) fail "无法解析 pgbackrest info --output=json（${FRESH}）" ;; esac
[[ "$FRESH" == code=0* ]] || fail "stanza 状态异常：${FRESH}"
AGE_H=$(sed -E 's/.*last_backup_age_h=([0-9.]+).*/\1/' <<<"$FRESH")
awk -v a="$AGE_H" -v m="$MAX_BACKUP_AGE_H" 'BEGIN{exit !(a > m)}' \
  && notify_warn "pgBackRest：最近一次成功备份已 ${AGE_H} 小时（阈值 ${MAX_BACKUP_AGE_H}h）" "$FRESH"

# ── 归档链路当前状态：pg_stat_archiver（info 的 archive.max 只是 WAL 段名，没有时间）──
# 「最近一次失败晚于最近一次成功」= 此刻归档正在失败 → 算失败；只是很久没归档 → 告警。
ARCH=$(psql_q "select coalesce(extract(epoch from now()-last_archived_time),1e9)::bigint::text
            || '|' || (last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time))::text
            || '|' || coalesce(last_failed_wal,'-') from pg_stat_archiver" 2>>"$LOG" || echo "")
if [[ -n "$ARCH" ]]; then
  IFS='|' read -r arch_age_s arch_failing arch_last_failed <<<"$ARCH"
  logline "pg_stat_archiver: age=${arch_age_s}s failing_now=${arch_failing} last_failed_wal=${arch_last_failed}"
  [[ "$arch_failing" == "true" || "$arch_failing" == "t" ]] && fail "archive_command 正在失败（last_failed_wal=${arch_last_failed}），RPO 已失守"
  (( arch_age_s > MAX_WAL_AGE_MIN * 60 && arch_age_s < 1000000000 )) \
    && notify_warn "pgBackRest：已 $(( arch_age_s / 60 )) 分钟没有成功归档 WAL（阈值 ${MAX_WAL_AGE_MIN} 分钟；库完全空闲时可忽略）"
else
  logline "警告：读不到 pg_stat_archiver（psql 失败？）"
fi

ELAPSED=$(( $(date +%s) - START ))
write_metrics 1
logline "OK (${ELAPSED}s)"
case "$NOTIFY_ON_SUCCESS" in
  all)  notify_ok "pgBackRest ${MODE} 成功（${ELAPSED}s）" "$FRESH" ;;
  full) [[ "$MODE" == full ]] && notify_ok "pgBackRest 周全量成功（${ELAPSED}s）" "$FRESH" ;;
esac
exit 0
