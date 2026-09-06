// 同步指示器四态（specs/06 §4.7）：synced 不画；syncing 呼吸点（>300ms 才亮）；offline 空心圈；error 实心 + 缺口。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SyncState } from "../../ipc/types.js";

export interface SyncDotProps {
  state: SyncState;
  onClick?: () => void;
  /** 便笺外（主窗/托盘文字）用 --c-text-3；便笺内用 --note-ink2 */
  inNote?: boolean;
}

export const SYNC_SHOW_DELAY_MS = 300;

export function SyncDot({ state, onClick, inNote = true }: SyncDotProps) {
  const { t } = useTranslation();
  const [showSyncing, setShowSyncing] = useState(false);
  useEffect(() => {
    if (state !== "syncing") {
      setShowSyncing(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSyncing(true), SYNC_SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const label =
    state === "synced"
      ? t("sync.synced")
      : state === "syncing"
        ? t("sync.syncing")
        : state === "offline"
          ? t("sync.offline")
          : state === "local"
            ? t("sync.local")
            : t("sync.conflict");

  if (state === "synced" || state === "local" || (state === "syncing" && !showSyncing)) {
    return <span className="note-sync note-sync--hidden" role="status" aria-label={label} title={label} />;
  }
  if (state === "error") {
    return (
      <button
        type="button"
        className={`note-sync note-sync--error${inNote ? "" : " note-sync--outside"}`}
        aria-label={label}
        title={label}
        onClick={onClick}
      />
    );
  }
  return (
    <span
      className={`note-sync note-sync--${state}${inNote ? "" : " note-sync--outside"}`}
      role="status"
      aria-label={label}
      title={label}
    />
  );
}
