// 把一张便笺弹成独立的浏览器窗口——列表窗口关掉之后它还在，这就是"便笺留在屏幕上"的做法。
//
// 三条平台现实，写在这里免得下次再查一遍：
//   ① 必须在**点击事件里**同步调用 window.open，异步之后再调一律被拦截器挡掉。
//   ② 同一张便笺复用同一个 window name，再点一次是聚焦已有窗口而不是再开一个。
//   ③ iPhone 上没有多窗口：Safari 和主屏 PWA 都不支持，window.open 要么跳去 Safari、
//      要么被忽略。所以入口只在有精确指针的设备上给（见 supportsNoteWindows）。
//      这不是实现问题，Web 平台没有别的路——真要在手机上浮着，只能做原生 App。

/** 一张便笺一个窗口名 */
export function noteWindowName(noteId: string): string {
  return `bianfa-note-${noteId}`;
}

/**
 * 这台设备值不值得给「新窗口」入口。
 *
 * 判据用 pointer: fine（鼠标/触控板）而不是 UA 字符串：多窗口本来就是桌面的事，
 * 而 UA 嗅探每隔两年就要坏一次。手机和平板是 pointer: coarse，拿不到这个入口——
 * 它们上面这个按钮点了也只会跳走一个新标签页，比没有还糟。
 */
export function supportsNoteWindows(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: fine)").matches;
}

/** 便笺窗口的默认大小：和桌面端一张便笺差不多 */
export const NOTE_WINDOW_SIZE = { width: 340, height: 440 } as const;

export type OpenResult = "opened" | "focused" | "blocked";

/**
 * @param existing 之前开过的窗口（调用方自己存着），用来区分"聚焦"和"新开"
 */
export function openNoteWindow(
  url: string,
  noteId: string,
  existing?: Window | null,
): { result: OpenResult; win: Window | null } {
  if (existing && !existing.closed) {
    existing.focus();
    return { result: "focused", win: existing };
  }
  const { width, height } = NOTE_WINDOW_SIZE;
  const win = window.open(url, noteWindowName(noteId), `popup,width=${width},height=${height},noopener=no`);
  // 被拦截器挡掉时返回 null——必须说出来，不然用户点了半天以为是坏的
  if (!win) return { result: "blocked", win: null };
  win.focus();
  return { result: "opened", win };
}
