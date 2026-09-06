import type { TFunction } from "i18next";

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
export function relativeTime(ms: number, t: TFunction, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutesAgo", { count: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 30) return t("time.daysAgo", { count: days });
  return new Date(ms).toLocaleDateString();
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  maxWait?: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: number | null = null;
  let first: number | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    first = null;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };
  const wrapped = (...args: A) => {
    pending = args;
    const now = Date.now();
    if (first === null) first = now;
    if (timer !== null) window.clearTimeout(timer);
    const remainingMax =
      maxWait === undefined ? Number.POSITIVE_INFINITY : Math.max(0, first + maxWait - now);
    timer = window.setTimeout(run, Math.min(wait, remainingMax));
  };
  wrapped.flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    run();
  };
  wrapped.cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    first = null;
    pending = null;
  };
  return wrapped;
}
