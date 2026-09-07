// 管理台内部共用的小零件：入口网关、异步取数、时间/动作文案。
// 只被 pages/admin/* 使用，不对外导出到别的页面。
import { Button } from "@bianfa/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchPlatformAdmins } from "../../admin-api.js";
import type { Result } from "../../api.js";
import { StateView } from "../../components/StateView.js";
import { type ApiFailure, describeFailure } from "../../lib/errors.js";
import { navigate } from "../../router.js";

// ─────────────────────────────────────────────────────────── 网关

/**
 * 进管理台之前先问一次服务端，结果决定整页渲染什么。
 *
 * 说明白一件事：**隐藏入口不是权限控制**。这里不渲染任何入口、路由也不出现在任何导航里，
 * 只是为了让普通用户不会误入一个必然失败的页面；真正拦住人的是服务端的 requireSuperAdmin
 * （非管理员 403 insufficient_role），改前端代码、直接敲 URL 或者 curl 端点都绕不过去。
 * 所以本文件对每种应答如实呈现，绝不本地推断「我应该是管理员」。
 */
export type GateState =
  | { kind: "checking" }
  | { kind: "allowed" }
  /** 403 insufficient_role：登录着，但不是总管理员 */
  | { kind: "forbidden" }
  /** 404：这个部署把管理面整面关掉了（PLATFORM_ADMIN_ENABLED=0） */
  | { kind: "disabled" }
  /** 401：会话对 /v1 无效 */
  | { kind: "unauthorized" }
  | { kind: "error"; failure: ApiFailure };

export function gateStateOf(failure: ApiFailure): GateState {
  if (failure.status === 403) return { kind: "forbidden" };
  if (failure.status === 404) return { kind: "disabled" };
  if (failure.status === 401) return { kind: "unauthorized" };
  return { kind: "error", failure };
}

/** 探针用 GET /v1/admin/admins：它是只读的、不写审计，最适合拿来问「我能进吗」 */
export function useAdminGate(): { gate: GateState; recheck: () => void } {
  const [gate, setGate] = useState<GateState>({ kind: "checking" });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 就是「重新检查一次」的开关，除了触发这个 effect 没有别的用处
  useEffect(() => {
    let alive = true;
    setGate({ kind: "checking" });
    void fetchPlatformAdmins().then((res) => {
      if (!alive) return;
      setGate(res.ok ? { kind: "allowed" } : gateStateOf(res.error));
    });
    return () => {
      alive = false;
    };
  }, [nonce]);
  return { gate, recheck: () => setNonce((n) => n + 1) };
}

/** 网关未通过时的整页状态（含「藏起来 ≠ 安全」这一条要说给用户听的话） */
export function GateBlocked({ gate, onRetry }: { gate: GateState; onRetry: () => void }) {
  const { t } = useTranslation();
  if (gate.kind === "forbidden") {
    return (
      <StateView
        kind="error"
        headline={t("admin.gate.forbidden")}
        title={t("admin.gate.forbiddenDetail")}
        detail={t("admin.gate.forbiddenHint")}
        actions={
          <Button variant="primary" size="lg" onClick={() => navigate("/account")}>
            {t("admin.gate.goAccount")}
          </Button>
        }
      />
    );
  }
  if (gate.kind === "disabled") {
    return (
      <StateView
        kind="info"
        headline={t("admin.gate.disabled")}
        title={t("admin.gate.disabledDetail")}
        detail={t("admin.gate.disabledHint")}
      />
    );
  }
  if (gate.kind === "unauthorized") {
    return (
      <StateView
        kind="error"
        headline={t("admin.gate.unauthorized")}
        title={t("admin.gate.unauthorizedDetail")}
        actions={
          <Button variant="primary" size="lg" onClick={() => navigate("/login?next=/admin")}>
            {t("admin.gate.goLogin")}
          </Button>
        }
      />
    );
  }
  if (gate.kind === "error") {
    return (
      <StateView
        kind="error"
        title={describeFailure(gate.failure)}
        actions={
          <Button variant="primary" size="lg" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  return <StateView kind="loading" title={t("common.loading")} />;
}

// ─────────────────────────────────────────────────────────── 取数

export interface QueryState<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
}

/**
 * 一次 GET 的加载 / 错误 / 数据三态。`key` 变了就重新取（把参数拼进 key 即可），
 * `reload()` 用于操作成功后刷新当前视图。
 */
export function useAdminQuery<T>(
  key: string,
  load: () => Promise<Result<T>>,
): QueryState<T> & { reload: () => void } {
  const [state, setState] = useState<QueryState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  // load 每次渲染都是新函数，放进依赖会无限循环；用 ref 取最新的一份，真正的依赖是 key
  const loadRef = useRef(load);
  loadRef.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 是调用方拼出来的查询指纹、nonce 是手动刷新的开关，两者都不出现在 effect 体内，但正是重新取数的条件
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ data: prev.data, error: null, loading: true }));
    void loadRef.current().then((res) => {
      if (!alive) return;
      if (res.ok) setState({ data: res.data, error: null, loading: false });
      else setState({ data: null, error: res.error, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [key, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** 子视图里的取数失败：不整页顶掉，给一行错误 + 重试 */
export function QueryError({ failure, onRetry }: { failure: ApiFailure; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <StateView
      kind="error"
      title={failure.status === 404 ? t("admin.notFound") : describeFailure(failure)}
      actions={
        <Button variant="primary" size="lg" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

// ─────────────────────────────────────────────────────────── 展示助手

/** 本地时区的 YYYY-MM-DD HH:mm；空值给一个短横线，别在表格里留空 */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 审计动作 → 文案键。键是 action 去掉 "admin." 前缀的部分（保持与服务端 ADMIN_ACTIONS 一致） */
const ADMIN_ACTION_KEYS: Record<string, string> = {
  user_frozen: "admin.actions.userFrozen",
  user_unfrozen: "admin.actions.userUnfrozen",
  password_set: "admin.actions.passwordSet",
  content_viewed: "admin.actions.contentViewed",
  user_listed: "admin.actions.userListed",
};

const OTHER_ACTION_KEYS: Record<string, string> = {
  "auth.sign_in_denied": "admin.actions.signInDenied",
  "authz.denied": "admin.actions.authzDenied",
};

/** 认不出来的动作原样显示动作码：宁可让人看见陌生的字符串，也不要悄悄吞掉一条审计 */
export function actionLabelKey(action: string): string | null {
  const suffix = action.startsWith("admin.") ? action.slice("admin.".length) : null;
  if (suffix && ADMIN_ACTION_KEYS[suffix]) return ADMIN_ACTION_KEYS[suffix] as string;
  return OTHER_ACTION_KEYS[action] ?? null;
}
