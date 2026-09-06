# infra/ —— 部署与运维（目录入口）

> **先读这里，再读 [`RUNBOOK.md`](RUNBOOK.md)。** 本目录由 5 路并行起草 + 5 路对抗审查 + 人工跨文件整合产出（2026-09-05）。
> 审查阶段共联网核实 83 条事实（镜像 tag 用 Docker Hub v2 API、Action 版本用 `git ls-remote`、Caddy/Alloy 配置用真二进制 `validate`）。
> 凡未能核实的都标了 `[待核实]`，见 §4；**不要把标注项当事实引用**。

## 0. 三条铁律（来自第 1 章跨模块裁定，效力高于第 9/10 章正文）

| | 裁定 | 落在哪 |
|---|---|---|
| **无公网入站** | VPS 不开任何入站端口（22/80/443 全关），全部经 Cloudflare Tunnel；SSH 走 Access | `vps/bootstrap.sh --lockdown`、`cloudflare/dns-and-waf.md` §2.2、`vps/break-glass.sh`（唯一临时放 443 的地方，`--revert` 收回） |
| **队列在 Postgres** | worker 跑 pg-boss（C8），Redis 无任何持久数据 → `allkeys-lru` / `appendonly no` / 不挂 volume | `docker/docker-compose.yml`（worker 无 `REDIS_URL`）、`docker/redis.conf` |
| **三把 R2 key** | releases（CI）/ backups（postgres 容器）/ attachments（api + worker，**绝不下发客户端**）（S5）| `cloudflare/r2.md` §6、`docker/.env.prod.example` |

另两条已落地的接缝裁定：Hocuspocus 持有 **1 条绕过 PgBouncer 的直连**专供 `LISTEN authz_revoked`（S3 → compose 的 `DATABASE_URL_DIRECT`）；`pgbackrest` 二进制**必须在 postgres 镜像内**（`archive_command` 由 PG 进程执行，sidecar 根本不会被调用 → `docker/pg/Dockerfile` 自建镜像）。

## 1. 文件地图

```
infra/
├─ README.md                 ← 本文件
├─ RUNBOOK.md                ← 运维手册：30 天首次部署 → 日常发版 → 备份恢复 → 7 条告警 → 故障手册 → 密钥清单 → 升级决策
├─ docker/                   ← VPS 上 /srv/bianfa/app/infra/docker，`docker compose --project-directory` 指向这里
│  ├─ docker-compose.yml     9 个服务：cloudflared×2 · caddy · api×2 · sync-ws · worker · pgbouncer · postgres · redis · alloy
│  ├─ Caddyfile              内网 :80；dynamic a（多行子块！单行写法是解析错误）；/ws/*→sync-ws:4000；/api/llm/* 关缓冲
│  ├─ .env.prod.example      全部环境变量清单 → 复制为 /srv/bianfa/.env.prod（root:root 0600，永不进 git）
│  ├─ .gitignore             忽略 .env.prod / .env
│  ├─ redis.conf             纯 ephemeral（见铁律 2）
│  ├─ pg/Dockerfile          pgvector 0.8.6-pg18 + pg_bigm 1.2 + pgbackrest（三者缺一不可）
│  ├─ pg/postgresql.conf     KVM 2 参数；io_method=worker（io_uring 在 Docker 默认 seccomp 下起不来）
│  ├─ pg/pg_hba.conf         只放 docker data 网段 + 容器回环，scram-sha-256
│  ├─ pg/pgbackrest.conf     → R2，aes-256-cbc，repo1-path=/pgbackrest；凭据经环境变量注入
│  ├─ pg/initdb/01-roles-and-extensions.sh   扩展 + 应用角色（NOBYPASSRLS）+ 监控角色
│  └─ alloy/config.alloy · alloy/pg-queries.yaml   → Grafana Cloud（监控不与被监控对象同机）
├─ vps/                      ← 宿主机脚本，全部 `bash -n` + shellcheck 通过
│  ├─ bootstrap.sh           新机从零到可部署：--prepare（用户/Docker/目录/cron）→ 验证 Access SSH 能进 → --lockdown（关公网 22）
│  ├─ tunnel-setup.md        两条 Tunnel：bianfa-prod（compose 内 ×2，api/ws）+ bianfa-ssh（宿主机 systemd，ssh）
│  ├─ deploy-entry.sh        CI 专用 deploy 用户的 forced command：current / deploy <tag> / deploy-with-env <tag>
│  ├─ deploy.sh              拉镜像 → up --wait → 健康检查失败自动回滚 → 写 .tag.current → prune；两端 Telegram
│  ├─ backup.sh + cron.d/bianfa   每日 incr / 周日 full；pgbackrest check 失败推 Telegram
│  ├─ restore.sh             灾难恢复 8 步（新机 → 拉库 → 校验 → 起服务），带确认提示
│  ├─ restore-checks.sql     业务校验，restore.sh 与 restore-drill.yml 共用；**表名待 apps/api schema 定稿后核对**
│  ├─ break-glass.sh         Tunnel 全挂时 5 分钟内直连恢复（--drill 演练 / --staging / --revert）；**平时必须演练过**
│  └─ notify.sh              Telegram 通知函数（其余脚本 source）
├─ cloudflare/
│  ├─ dns-and-waf.md         DNS 记录表、WAF 规则、100 秒源站超时对 SSE 的含义
│  ├─ r2.md                  三个桶 + token 最小权限矩阵 + CORS + 法域
│  ├─ attachments-cors.json  R2 API 形状（S3 形状会被 wrangler 拒绝）
│  ├─ access-ssh.md          Access 保护 SSH：应用 / 策略 / 短时证书 / CI service token
│  ├─ update-worker/         latest.json 路由 + 按 installId 灰度 + KV KILL_SWITCH
│  └─ healthcheck-worker/    每分钟打 /healthz，连续 2 次失败推 Telegram
└─ ci/
   └─ make-selfsign-cert.sh 一次性生成 macOS 自签名代码签名证书（ADR-001），输出三个 MACOS_SELFSIGN_* secret

.github/workflows/
├─ backend.yml       PR：lint/typecheck/单测/集成测试（ephemeral PG+Redis，代替 staging）；main：build → ghcr → ssh deploy → 冒烟 → 失败回滚
├─ desktop.yml       tag v*：构建 → 代码签名**可选**（ADR-001：Windows 有 AZURE_* 才签；macOS Developer ID 优先、否则自签名、禁 ad-hoc；有 API Key 才公证）→ minisign → R2 → latest.json；含「产物不含私钥」「非 ad-hoc」断言
├─ restore-drill.yml 每月 1 号：runner 上从 R2 恢复 → pg_amcheck → 业务 SQL → Telegram（没演练过的备份等于没有备份）
└─ security.yml      gitleaks 全历史 / cargo deny / npm audit / Trivy
```

**仓库里还不存在、但上面的文件依赖的东西**：`apps/api`、`apps/sync` 的源码与 Dockerfile（compose 拉 `ghcr.io/<org>/bianfa-api` / `bianfa-sync`，backend.yml 负责构建）；数据库 schema（`restore-checks.sql` 的三个表名按第 4 章 DDL 与 C9 写，定稿后核对）。

## 2. 首次部署怎么走

按 `RUNBOOK.md` §2 的 D1–D14 顺序，**不要按兴趣排**：D1 生成 macOS 自签名证书（ADR-001；Azure / Apple 签名身份申请改为可选）→ D3–5 建 Tunnel + `bootstrap.sh --prepare` + 验证 Access SSH + **演练一次 break-glass** → `--lockdown` → D6–8 自建 pg 镜像起栈 → D9–10 配 pgBackRest 并**立刻做一次 restore 演练** → D11–12 Alloy + 7 条告警 → D13+ 业务代码。

日常：合并 `main` → `backend.yml` 自动部署（镜像 tag `sha-<40hex>`，**不重推 `.env.prod`**）；打 `v*` tag → `desktop.yml` 发桌面端。密钥变更走人工 `ssh bianfa-prod deploy-with-env <tag> < rendered.env.prod`。

## 3. 与裁定文字的三处已知偏差（诚实记录，不是遗漏）

| 裁定原文 | 实际能做到的 | 为什么 |
|---|---|---|
| S5：releases / backups 的 R2 key「只写」 | Object Read & Write，限定到单桶 | R2 token 只有 4 档（`r2/api/tokens.mdx` 逐字核实），**没有 write-only**；且 pgBackRest 的 expire 阶段必须能读 `backup.info` 与删过期对象，缺 Delete 会让每日备份报错。补偿：桶级对象锁定 + 版本目录不可变 + git tag 可重建任意版本 |
| 第 9 章 8.7：备份加密口令「不存 VPS」 | 口令的**权威副本**在 VPS 之外（密码管理器），VPS 上 `.env.prod` 里有一份运行副本 | `archive_command` 由 PG 进程执行，容器环境里必须有 `PGBACKREST_REPO1_CIPHER_PASS`，否则 WAL 归档根本跑不起来。「不存 VPS」在这个架构下不可达 |
| RUNBOOK 初稿：服务端也用 `v1.2.3` 举例 | 服务端镜像 tag = `sha-<40hex>` | `v*` 是 desktop.yml 的触发前缀，两条流水线共用命名空间会互相误触发 |

## 4. 必须人工替换的占位符

全文统一写法 `<REPLACE_ME:…>`，**不要用会被误当真值的假数据**。grep 一遍确认为零再上线：`grep -rn 'REPLACE_ME' infra .github docs`。

| 占位符 | 出现在 |
|---|---|
| `<REPLACE_ME:domain>` | docs/用户手册-安装与使用.md, infra/RUNBOOK.md, infra/cloudflare/access-ssh.md, infra/cloudflare/dns-and-waf.md, infra/cloudflare/healthcheck-worker/wrangler.toml, infra/cloudflare/r2.md, infra/cloudflare/update-worker/src/index.ts, infra/cloudflare/update-worker/wrangler.toml, infra/vps/tunnel-setup.md |
| `<REPLACE_ME:ghcr-namespace>` | .github/workflows/backend.yml, .github/workflows/restore-drill.yml, .github/workflows/security.yml |
| `<REPLACE_ME:kv-namespace-id>` | infra/RUNBOOK.md, infra/cloudflare/healthcheck-worker/wrangler.toml, infra/cloudflare/update-worker/wrangler.toml |
| `<REPLACE_ME:tunnel-id-prod>` | infra/RUNBOOK.md, infra/cloudflare/dns-and-waf.md, infra/vps/tunnel-setup.md |
| `<REPLACE_ME:vps-ip>` | infra/RUNBOOK.md, infra/cloudflare/access-ssh.md, infra/cloudflare/dns-and-waf.md |
| `<REPLACE_ME:...>` | infra/cloudflare/update-worker/src/index.ts, infra/vps/tunnel-setup.md |
| `<REPLACE_ME:account-id>` | infra/RUNBOOK.md, infra/cloudflare/r2.md |
| `<REPLACE_ME:admin-email>` | infra/RUNBOOK.md, infra/cloudflare/access-ssh.md |
| `<REPLACE_ME:cloudflare-account-id>` | .github/workflows/desktop.yml, .github/workflows/restore-drill.yml |
| `<REPLACE_ME:ops-user-ed25519-public-key>` | infra/RUNBOOK.md, infra/vps/bootstrap.sh |
| `<REPLACE_ME:telegram-bot-token>` | infra/vps/bootstrap.sh, infra/vps/notify.sh |
| `<REPLACE_ME:telegram-chat-id>` | infra/vps/bootstrap.sh, infra/vps/notify.sh |
| `<REPLACE_ME:tunnel-token-ssh>` | infra/RUNBOOK.md, infra/cloudflare/access-ssh.md |
| `<REPLACE_ME:32-bytes-random-kept-in-password-manager>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:admin-email-prefix>` | infra/cloudflare/access-ssh.md |
| `<REPLACE_ME:admin-unix-user>` | infra/cloudflare/access-ssh.md |
| `<REPLACE_ME:api.domain>` | .github/workflows/backend.yml |
| `<REPLACE_ME:bundle-id>` | docs/用户手册-安装与使用.md |
| `<REPLACE_ME:cdn.domain>` | .github/workflows/desktop.yml |
| `<REPLACE_ME:cloudflare-access-ssh-ca-public-key>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:cloudflare-tunnel-token-bianfa-prod>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:cloudflare-tunnel-token-bianfa-ssh>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:deploy-ci-ed25519-public-key>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:dmarc-mailbox>` | infra/cloudflare/dns-and-waf.md |
| `<REPLACE_ME:email-prefixes-comma-separated>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:example.com>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:ghcr-org>` | infra/RUNBOOK.md |
| `<REPLACE_ME:initial-image-tag>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:mail-provider-spf>` | infra/cloudflare/dns-and-waf.md |
| `<REPLACE_ME:migrate-command>` | infra/RUNBOOK.md |
| `<REPLACE_ME:monthly-budget-usd>` | infra/RUNBOOK.md |
| `<REPLACE_ME:ops-email-for-lets-encrypt>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:pages-project>` | infra/cloudflare/dns-and-waf.md |
| `<REPLACE_ME:postgres-superuser-password>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:r2-bianfa-backups-rw-access-key-id>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:r2-bianfa-backups-rw-secret-access-key>` | infra/vps/bootstrap.sh |
| `<REPLACE_ME:repo-url>` | infra/RUNBOOK.md |
| `<REPLACE_ME:ssh.domain>` | .github/workflows/backend.yml |
| `<REPLACE_ME:support-email>` | docs/用户手册-安装与使用.md |
| `<REPLACE_ME:team-name>` | infra/cloudflare/access-ssh.md |
| `<REPLACE_ME:tunnel-id-ssh>` | infra/cloudflare/dns-and-waf.md |
| `<REPLACE_ME:vps-ssh-host-public-key>` | .github/workflows/backend.yml |
| `<REPLACE_ME:zone-id>` | infra/cloudflare/r2.md |

## 5. 待核实项（审查员未能联网核实，按常识处理；上线前逐条确认）

- **[stack]** deploy.sh 第 3 步在 api 容器里用 `wget` 打 /healthz；本 compose 的 healthcheck 用 `node -e fetch(...)` 不假设镜像有 wget。二者不冲突，但 apps/api 镜像若是 distroless/无 wget，deploy.sh 那一行会误判回滚——请让 api 镜像装 wget，或把 deploy.sh 那行改成同样的 node -e。
- **[stack]** (1) pgbackrest 在 trixie-pgdg apt 源里的具体版本号，本轮无法访问 apt.postgresql.org，构建日志 `pgbackrest version` 为准；(2) cAdvisor 在 read_only + cap_drop ALL + 仅 DAC_READ_SEARCH/SYS_PTRACE 下能否完整读 cgroup v2 统计，需真机确认（不行则给 alloy 加 SYS_ADMIN 或去掉 cadvisor 组件）；(3) apps/api 镜像 WORKDIR 下 `dist/worker.js` 路径、uid 10001、/healthz 与 /metrics 契约，以 apps/ 定稿为准；(4) Alloy `enabled_collectors` 取值与 `custom_queries_config_path` 文件格式只在运行期校验，首次起 alloy 后看 `dock…
- **[ci]** (a) pgvector 基础镜像（Debian trixie，postgresql-18 依赖 postgresql-client-18）是否带 pg_amcheck——drill 在运行时断言；(b) pg_bigm 是否必须在 shared_preload_libraries（README 抓取未命中）——沿用第 9 章 8.6 配置；(c) GitHub runner 里 `nohup … &` 起的进程跨 step 存活（业界常用做法，未查到官方文档明确保证）；(d) `docker restart` 服务容器后 pgbouncer→postgres 的 DNS 复用（Docker 内嵌 DNS 通常按名解析，建议长期改为 initdb.d 脚本设 shared_preload_libraries）；(e) Tauri 公证后是否对 .app 执行 stapler（`xcrun stapler validate` 依赖…
- **[vps]** Bot API 7.0 已用 link_preview_options 取代 disable_web_page_preview（changelog 核实）；旧参数是否仍被接受未核实，故只用新参数。
- **[vps]** Hostinger hPanel 浏览器 Terminal 菜单路径；Cloudflare 控制台 Routes/Published application 措辞；ufw `delete allow in 443/tcp` 是否匹配带 comment 的规则（已加按编号删除兜底，awk 解析经样例验证）；Telegram 旧参数兼容性；docker compose `run --entrypoint ''` 空串行为（已规避）。
- **[cf]** CF_API_TOKEN 权限名：fundamentals/api/reference/permissions 列出账号级「Cloudflare Tunnel Read = Grants access to view Cloudflare Tunnels」，去掉初稿 [待核实]。同时确认 2026-07-09 changelog：2026-10-05 起 tunnel 对象内 connections 字段下线，Worker 用的专用端点 `/cfd_tunnel/{id}/connections` 正是替代路径，响应结构（id/features/version/arch/run_at/conns[].is_pending_reconnect）与 cloudflared cfapi/tunnel.go 一致。
- **[cf]** (a) bucket lock 与 lifecycle 冲突时 lock 优先（bucket-locks.mdx 明文），去掉初稿 [待核实]；(b) 临时凭据 API：`actions`（按 S3 操作精确放行）文档写 “currently supported via local signing only… coming soon”，初稿声称能签出“不含 DeleteObject”的凭据不成立，已改为只能限桶/前缀/权限档/TTL；(c) R2 S3 兼容表标 `x-amz-sdk-checksum-algorithm` 未实现、CRC32 只支持 COMPOSITE，故 `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` 从“报错时再加”改为必须；(d) `--min-tls` 不写默认 1.0（domain.ts），强调显式 1.2；(e) 补 CI 侧硬要求：Actions …
- **[cf]** Cloudflare 侧文件不涉及 Redis/worker/Hocuspocus DSN；ufw 段与「VPS 无公网入站」一致，本轮补充 “Docker ports: 绕过 ufw，compose 主文件不得有 ports:”；pgBackRest 在 postgres 容器内（r2.md §4.1 表述一致）；Caddy `dynamic a` 已用并实测；WS 服务命名 sync-ws（Hocuspocus 4.6.0，C2）。**一处对裁定的技术性修正需人工确认**：第 9 章 8.7「repo1-cipher-pass 不存 VPS」在字面上不可实现（archive_command 由 VPS 上的 PG 进程每分钟调用 pgBackRest 加密 WAL），r2.md 保留初稿的重新表述“备份副本存 VPS 之外，VPS 上一份与 .env.prod 同级保护”，并在文中标注需裁定方确认。
- **[cf]** R2 是否存在对象版本控制（只能证明文档中无）；自定义域 + 法域桶组合；R2 token 创建页是否有客户端 IP 过滤（tokens.mdx 未提及）；R2 是否接受 GitHub OIDC 联合身份；Cloudflare 边缘是否把 h2 WebSocket 降为 h1；Universal SSL 当前 CA 列表（CAA）；R2 pricing 数字沿用初稿未重抓；Telegram Bot API 具体版本号不再断言。developers.cloudflare.com 与 devblogs.microsoft.com 被出口代理阻断，所有 Cloudflare 文档均改从 GitHub raw（cloudflare/cloudflare-docs production 分支）与 workers-sdk 源码核实。
- **[guides]** 快捷键按第 12 章 §7 更正 13 / 第 18 章裁决 7 改：便笺内新建 Ctrl+N（初稿 Ctrl+Shift+N 是已删除的别名）、石墨 Ctrl+Shift+0（初稿 Ctrl+0 是第 13 章旧值）、新增 Ctrl+0 = 界面缩放复位；Esc 链按第 16 章 F5 改为 7 级（末尾「编辑器失焦，窗口不关」）；Ctrl+E 行按第 18 章裁决 3 改语义；登录等待由 20 秒改为第 6 章的 60 秒；验证码「30 分钟」无来源，改为不写具体数值并标待核实；AI 云代理「一次回答最多 100 秒」改为「首个字最多等 100 秒」（S2：首 chunk < 100s，Cloudflare 524）；WebView2 离线包体积 130 → 127 MB（第 3 章 2.4.4）；macOS 更新改为「提示重启以完成更新」；FAQ 6 去掉架构里不存在的 status.<domain> 状态页，改官网公告，…
- **[guides]** §6.3 pgbouncer 管理控制台补 `postgres@` 用户并标注需在 ADMIN_USERS 内 [待核实 compose 取值]；§6.5 LISTEN 连接检测改为 `query ilike 'listen%'`（application_name 名未定）；§5.3 第二个 docker run 补上 pgbackrest.conf 挂载与 -e 环境变量（否则 restore_command 无法取 WAL）；§6.6 三条 SQL 直接放进 heredoc 而不是空 heredoc；§4.3 `cd && sudo -u ops git pull` 改为 `sudo -u ops git -C … pull`；D3 补 ACME_EMAIL（break-glass.sh 读取）。
- **[guides]** Hostinger「KVM 8 不能再升」与原地升级细节（本轮未访问 Hostinger）；Alloy 组件参数名（grafana.com 被出口代理阻断）；healthcheck Worker 的 CF_API_TOKEN 权限组名；postgres_exporter 是否暴露 pg_stat_archiver 年龄；Cloudflare Tunnel 健康通知的控制台名称；edoburu/pgbouncer 的 ADMIN_USERS 默认值（README 未给）。

## 6. 本地校验（提交前跑一遍）

```bash
# compose 语法与 :? 必填变量守卫（用 example 顶替真实密钥）
sed 's/<REPLACE_ME:[^>]*>/x/g' infra/docker/.env.prod.example > /tmp/env.check && \
  docker compose --project-directory infra/docker --env-file /tmp/env.check config -q && echo compose OK
# 脚本
for f in infra/vps/*.sh; do bash -n "$f" && shellcheck -S warning "$f"; done
# 工作流 YAML
python3 -c 'import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob(".github/workflows/*.yml")];print("yaml OK")'
# 裁定残留（应只命中解释性注释）
grep -rnE 'BullMQ|appendonly yes|ufw allow (22|80)|@v[0-9]+$' infra .github
```
