# 平台分叉清单（specs/06 §0 / 05 §9.1 红线 3）

`grep -rn 'data-os' src/components src/windows` 必须为空；所有 `[data-os]` 与 `isMac()` 分叉只出现在下列位置。

| # | 分叉 | 位置 |
|---|---|---|
| 1 | `--r-window`：Windows/Linux 0，macOS 10px | `src/platform/static-tail.css` |
| 2 | 字重：Windows `--fw-medium:400 / --fw-strong:700` | `src/platform/static-tail.css` |
| 3 | caption 按钮：Windows 右缘单枚 ✕；macOS 左缘 12px 关闭点、色点让位到右侧组首位 | `src/windows/note/TitleBar.tsx`（`isMac()`） |
| 4 | 原生 vibrancy / `backdrop-filter`：仅 settings 窗；便笺窗恒实色 | `src/styles/settings.css`、Rust `settings.rs` |
| 5 | 托盘左/右键语义（Win 左键新建、mac 左键菜单） | Rust `src-tauri/src/tray.rs` |
| 6 | 快捷键符号与修饰键（⌘ vs Ctrl；删除线 ⌘⇧X vs Ctrl+T） | `src/lib/platform.ts`、`src/lib/shortcuts.ts` |
