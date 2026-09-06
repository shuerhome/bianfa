# syntax=docker/dockerfile:1
# =============================================================================
# bianfa · 自建 PostgreSQL 镜像：pgvector 0.8.6 + pg_bigm 1.2 + pgBackRest（PostgreSQL 18.6, Debian trixie）
# -----------------------------------------------------------------------------
# 来源：第 9 章 8.5（三个会炸的坑）、8.6（扩展锁版）、8.7（pgBackRest 必须在 postgres 镜像内）、
#       第 1 章 C6（pg_bigm 而非 PGroonga）。
#
# 为什么必须自建（8.5 已核实）：
#   1. pgvector/pgvector:0.8.6-pg18-trixie 不含 pg_bigm；postgresql.conf 里 shared_preload_libraries
#      写了 pg_bigm 而 .so 不存在 → Postgres 直接启动失败。
#   2. archive_command 由 Postgres 进程自己执行 → pgbackrest 二进制必须在同一个容器里，sidecar 不会被调用。
#
# 版本核实（2026-09-05）：
#   * Docker Hub pgvector/pgvector 存在 tag 0.8.6-pg18-trixie（2026-08-13 推送；Docker Hub v2 API）。
#   * pg_bigm 仓库**没有**叫 `v1.2` 的 tag（第 9 章 8.5 的 `--branch v1.2` 会 clone 失败）；
#     `git ls-remote --tags` 实测最新为 v1.2-20250903（其前 v1.2-20240606）。
#   * pgbackrest 来自基础镜像已配置好的 apt.postgresql.org (trixie-pgdg) 源；上游源码当前 2.60.0（第 9 章 8.7 核实），
#     apt 里落地的具体版本以构建日志中 `pgbackrest version` 的输出为准 [待核实：本轮未能访问 apt.postgresql.org]。
#
# 必须人工替换：无。想升级 pg_bigm 改 build-arg PG_BIGM_TAG 即可。
# =============================================================================
FROM pgvector/pgvector:0.8.6-pg18-trixie

ARG PG_MAJOR=18
ARG PG_BIGM_TAG=v1.2-20250903

# 与基础镜像同样的 apt 纪律：hold locales 防被 autoremove 连带；构建依赖装完即卸。
RUN set -eux; \
    apt-get update; \
    apt-mark hold locales; \
    # --- 运行期依赖：pgbackrest（archive_command / backup / restore）+ TLS 根证书（连 R2）
    apt-get install -y --no-install-recommends \
        pgbackrest \
        ca-certificates; \
    # --- 构建期依赖：编译 pg_bigm
    #     libicu-dev：PostgreSQL 18 起 tsearch/ts_locale.h → utils/pg_locale.h 在 USE_ICU 下 #include <unicode/ucol.h>
    #     （已核实 REL_18_STABLE 源码），PGDG 包都是 ICU 构建，缺它 bigm_op.c 第一行 include 就 "compilation terminated"
    #     （2026-09-06 首台机器实测）。pg_bigm 上游 CI 自己从源码编 PG、不带 ICU，所以他们没踩到。
    apt-get install -y --no-install-recommends \
        build-essential \
        "postgresql-server-dev-${PG_MAJOR}" \
        libicu-dev \
        git; \
    git clone --depth 1 --branch "${PG_BIGM_TAG}" https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm; \
    make -C /tmp/pg_bigm USE_PGXS=1 PG_CONFIG="/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config"; \
    make -C /tmp/pg_bigm USE_PGXS=1 PG_CONFIG="/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config" install; \
    # --- 卸掉构建依赖（pgbackrest / ca-certificates 是手动安装的，不会被 autoremove）
    apt-get purge -y --auto-remove build-essential "postgresql-server-dev-${PG_MAJOR}" libicu-dev git; \
    apt-mark unhold locales; \
    rm -rf /var/lib/apt/lists/* /tmp/pg_bigm; \
    # --- pgbackrest 运行目录预建并归 postgres：compose 用 named volume 挂 /var/spool/pgbackrest，
    #     首次创建时会继承镜像内该路径的属主，否则会是 root 属主导致 archive-push（以 postgres 运行）写不进去。
    #     /var/log/pgbackrest 与 /tmp 在 compose 里是 tmpfs（1777），这里预建只为裸 `docker run` 也能跑。
    install -d -o postgres -g postgres -m 0750 /var/spool/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest; \
    # --- 自检：缺一个就让构建失败，而不是等到生产启动才炸
    test -f "/usr/lib/postgresql/${PG_MAJOR}/lib/pg_bigm.so"; \
    test -f "/usr/share/postgresql/${PG_MAJOR}/extension/pg_bigm.control"; \
    test -f "/usr/lib/postgresql/${PG_MAJOR}/lib/vector.so"; \
    test -f "/usr/lib/postgresql/${PG_MAJOR}/lib/pg_stat_statements.so"; \
    pgbackrest version

# 默认以 postgres(999) 运行：`docker compose exec postgres pgbackrest …` 因而不会以 root 往 spool/log 里写 root 属主文件。
# compose 里也显式 user: "999:999"，两处一致。官方 entrypoint 检测到非 root 会跳过 chown/gosu 直接走 initdb。
USER postgres
