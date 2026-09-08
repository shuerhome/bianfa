// 一次 GET 的「加载 / 失败 / 数据」三态。`key` 是调用方拼出来的查询指纹，变了就重新取；
// `reload()` 用于写操作成功后刷新当前视图。管理台与便笺列表共用这一份。
import { useEffect, useRef, useState } from "react";
import type { Result } from "../api.js";
import type { ApiFailure } from "./errors.js";

export interface QueryState<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
}

export function useQuery<T>(
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
