#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Windows 便笺（经典版 UWP Sticky Notes）导出为 JSON + Markdown。

零依赖，只用 Python 标准库。在你自己的 Windows 电脑上跑：

    python export_sticky_notes.py

它会：
  1. 找到 plum.sqlite（连同 -wal / -shm 一起复制到临时目录再只读打开，绝不写回原库）
  2. 按列名而非列序号读取（列集在各小版本间会漂移，实测有 18 列和 19 列两种）
  3. 富文本优先用 LastServerVersion 的 JSON，没有才降级解析私有 Text 格式
  4. 导出 bianfa-export/notes.json（全保真）+ bianfa-export/markdown/*.md（可读）
  5. 把原始三件套原封不动归档到 bianfa-export/raw/ —— 这本身就是一份你从未拥有过的备份

只读。不会修改、移动或删除你的任何便笺。

其它用法：
    python export_sticky_notes.py --schema        只打印库结构，不导出（排查用）
    python export_sticky_notes.py --db <路径>     手动指定 plum.sqlite
    python export_sticky_notes.py --out <目录>    指定输出目录
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

# ── 经典版 UWP Sticky Notes 的包标识（新版随 OneNote 发布的没有可读迁移路径）──
PKG = "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe"

# 原版 7 色 → 淡彩纸 10 色色板
THEME_MAP = {
    "yellow": "citron", "green": "fern", "blue": "azure", "purple": "violet",
    "pink": "rose", "gray": "graphite", "grey": "graphite", "charcoal": "graphite",
}

# .NET ticks（100ns 为单位，起点 0001-01-01）→ Unix 毫秒
TICKS_EPOCH_OFFSET_MS = 62135596800000


def ticks_to_ms(ticks):
    if not ticks:
        return None
    try:
        ms = int(ticks) // 10000 - TICKS_EPOCH_OFFSET_MS
    except (TypeError, ValueError):
        return None
    # 合理区间：1990 ~ 2100，超出说明这一列存的不是 ticks
    return ms if -631152000000 < ms < 4102444800000 else None


def ms_to_iso(ms):
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


# ── 窗口位置：ManagedPosition=DeviceId:...;Position=x,y;Size=w,h ──────────────
# 坐标可以是负数（多显示器时左侧/上方的屏幕就是负值）。用 \d+ 会静默漏掉这批用户。
POS_RE = re.compile(r"Position=(-?\d+),(-?\d+)", re.I)
SIZE_RE = re.compile(r"Size=(\d+),(\d+)", re.I)
DEV_RE = re.compile(r"DeviceId:([^;]+)", re.I)


def parse_window_position(s):
    if not s:
        return None
    out = {}
    m = POS_RE.search(s)
    if m:
        out["x"], out["y"] = int(m.group(1)), int(m.group(2))
    m = SIZE_RE.search(s)
    if m:
        out["w"], out["h"] = int(m.group(1)), int(m.group(2))
    m = DEV_RE.search(s)
    if m:
        out["display_id"] = m.group(1).strip()
    return out or None


# ── 私有 Text 格式 ───────────────────────────────────────────────────────────
# 不是 RTF、不是 HTML、不是标准 Markdown。段落以 \id=<GUID> 前缀开头，
# 行内格式在不同版本分别用过 RTF 风格控制字和 Markdown 风格标记。
ID_PREFIX_RE = re.compile(r"\\id=[0-9A-Fa-f\-]+\s?")
# 分隔符只吃单个空格/制表符，不能吃换行 —— RTF 控制字的终止符是空格，
# 用 \s? 会把 "\b0\par" 展开后紧随的换行一起吞掉，导致段落被粘连。
CTRL_RE = re.compile(r"\\([a-zA-Z]+)(-?\d+)?[ \t]?")

# RTF 风格控制字 → Markdown 标记（开/关）
CTRL_MD = {
    "b": ("**", "**"), "i": ("*", "*"),
    "ul": ("<u>", "</u>"), "ulnone": None,
    "strike": ("~~", "~~"),
}


def parse_text_field(raw):
    """返回 (markdown, plain, degraded)。无法识别的控制字丢弃而非原样显示。"""
    if not raw:
        return "", "", False
    degraded = False
    s = raw.replace("\r\n", "\n")
    s = ID_PREFIX_RE.sub("", s)
    s = s.replace("\\par", "\n")

    open_tags = []
    out = []
    pos = 0
    for m in CTRL_RE.finditer(s):
        out.append(s[pos:m.start()])
        pos = m.end()
        word, arg = m.group(1), m.group(2)
        if word == "par":
            out.append("\n")
            continue
        pair = CTRL_MD.get(word)
        if pair is None:
            if word not in ("id", "ulnone"):
                degraded = True          # 不认识的控制字：丢弃，但记账
            while open_tags:             # ulnone 之类的关闭指令
                out.append(open_tags.pop())
            continue
        if arg == "0":                   # \b0 \i0 \ul0 = 关闭
            if pair[1] in open_tags:
                open_tags.remove(pair[1])
            out.append(pair[1])
        else:
            open_tags.append(pair[1])
            out.append(pair[0])
    out.append(s[pos:])
    while open_tags:
        out.append(open_tags.pop())

    md = "".join(out)
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    plain = re.sub(r"\*\*|~~|\*|</?u>", "", md)
    return md, plain, degraded


def parse_server_version(raw):
    """LastServerVersion 是云端规范化 JSON，是富文本的真源。结构容错。"""
    if not raw:
        return None
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError):
        return None
    lines = []

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("text"), str):
                lines.append(node["text"])
                return
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    text = "\n".join(x for x in lines if x is not None).strip()
    return text or None


# ── 定位 ─────────────────────────────────────────────────────────────────────
def find_db(explicit=None):
    if explicit:
        return explicit if os.path.exists(explicit) else None
    local = os.environ.get("LOCALAPPDATA")
    if local:
        p = os.path.join(local, "Packages", PKG, "LocalState", "plum.sqlite")
        if os.path.exists(p):
            return p
    # 非 Windows 或路径不同：在当前目录找一份（便于用拷贝出来的库做验证）
    for c in ("plum.sqlite", os.path.join("raw", "plum.sqlite")):
        if os.path.exists(c):
            return c
    return None


def open_readonly_copy(src, tmpdir):
    """三件套一起复制到临时目录再只读打开 —— Sticky Notes 运行时持有 WAL 锁，
    最近的编辑都还在 -wal 里，只复制主库会丢掉它们。"""
    dst = os.path.join(tmpdir, "plum.sqlite")
    copied = []
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copyfile(src + ext, dst + ext)
            copied.append(ext or "(主库)")
    conn = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn, copied


def table_columns(conn, table):
    try:
        return {r["name"] for r in conn.execute(f'PRAGMA table_info("{table}")')}
    except sqlite3.Error:
        return set()


def main():
    ap = argparse.ArgumentParser(description="导出 Windows 便笺")
    ap.add_argument("--db", help="plum.sqlite 路径（默认自动查找）")
    ap.add_argument("--out", default="bianfa-export", help="输出目录")
    ap.add_argument("--schema", action="store_true", help="只打印库结构，不导出")
    args = ap.parse_args()

    src = find_db(args.db)
    if not src:
        print("✗ 没找到 plum.sqlite。", file=sys.stderr)
        print(f"  默认位置：%LOCALAPPDATA%\\Packages\\{PKG}\\LocalState\\plum.sqlite", file=sys.stderr)
        print("  如果你用的是随 OneNote 发布的新版便笺，它没有可读的迁移路径。", file=sys.stderr)
        print("  也可以用 --db 手动指定路径。", file=sys.stderr)
        return 2
    print(f"→ 数据库：{src}")

    with tempfile.TemporaryDirectory() as tmp:
        conn, copied = open_readonly_copy(src, tmp)
        print(f"→ 已复制并只读打开：{'、'.join(copied)}")

        tables = {r["name"] for r in
                  conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        note_cols = table_columns(conn, "Note")

        if args.schema or not note_cols:
            print(f"\n库中的表：{', '.join(sorted(tables)) or '（空）'}")
            for t in sorted(tables):
                cols = sorted(table_columns(conn, t))
                print(f"\n[{t}] {len(cols)} 列\n  {', '.join(cols)}")
            if not note_cols:
                print("\n✗ 没有 Note 表，这可能不是 plum.sqlite。", file=sys.stderr)
                return 2
            return 0

        def has(c):
            return c in note_cols

        def col(name, default="NULL"):
            return f'"{name}"' if has(name) else default

        # 按列名取值，绝不按列序号 —— 列集在各小版本间漂移（实测有 18 列和 19 列两种）
        sql = f"""SELECT "Id" AS id,
                         {col('Text')}               AS text,
                         {col('LastServerVersion')}   AS server_version,
                         {col('Theme')}               AS theme,
                         {col('IsOpen')}              AS is_open,
                         {col('IsAlwaysOnTop')}       AS pinned,
                         {col('WindowPosition')}      AS winpos,
                         {col('CreatedAt')}           AS created,
                         {col('UpdatedAt')}           AS updated,
                         {col('DeletedAt')}           AS deleted,
                         {col('Type')}                AS type
                  FROM "Note" """
        rows = list(conn.execute(sql))

        # 附件
        media_by_note = {}
        if "Media" in tables:
            mc = table_columns(conn, "Media")
            if {"ParentId", "LocalFileRelativePath"} <= mc:
                mime = '"MimeType"' if "MimeType" in mc else "NULL"
                for r in conn.execute(
                        f'SELECT "ParentId" AS pid, "LocalFileRelativePath" AS path, {mime} AS mime FROM "Media"'):
                    media_by_note.setdefault(r["pid"], []).append(
                        {"path": r["path"], "mime": r["mime"]})

        # 墨迹：格式私有，无法转换，只打标记提示用户
        ink_notes = set()
        if "Stroke" in tables and "ParentId" in table_columns(conn, "Stroke"):
            ink_notes = {r[0] for r in conn.execute('SELECT DISTINCT "ParentId" FROM "Stroke"')}

        conn.close()

    notes, deleted_n, degraded_n = [], 0, 0
    for r in rows:
        if r["deleted"]:
            deleted_n += 1
            continue
        src_field = "LastServerVersion"
        body = parse_server_version(r["server_version"])
        degraded = False
        if body is None:
            src_field = "Text"
            md, body, degraded = parse_text_field(r["text"])
        else:
            md = body
        if degraded:
            degraded_n += 1

        theme = (r["theme"] or "").strip().lower()
        title = next((ln.strip() for ln in (body or "").split("\n") if ln.strip()), "")
        notes.append({
            "external_id": r["id"],
            "source": "plum.sqlite",
            "title": title[:60],
            "markdown": md,
            "text": body or "",
            "color": THEME_MAP.get(theme, "citron"),
            "original_theme": r["theme"],
            "pinned": bool(r["pinned"]),
            "is_open": bool(r["is_open"]),
            "window": parse_window_position(r["winpos"]),
            "created_at": ms_to_iso(ticks_to_ms(r["created"])),
            "updated_at": ms_to_iso(ticks_to_ms(r["updated"])),
            "attachments": media_by_note.get(r["id"], []),
            "has_ink": r["id"] in ink_notes,
            "content_source": src_field,
            "import_degraded": degraded,
        })

    notes.sort(key=lambda n: n["updated_at"] or "", reverse=True)

    out = args.out
    os.makedirs(os.path.join(out, "markdown"), exist_ok=True)
    os.makedirs(os.path.join(out, "raw"), exist_ok=True)

    with open(os.path.join(out, "notes.json"), "w", encoding="utf-8") as f:
        json.dump({"exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "source_db": os.path.abspath(src), "count": len(notes),
                   "notes": notes}, f, ensure_ascii=False, indent=2)

    for i, n in enumerate(notes, 1):
        safe = re.sub(r'[\\/:*?"<>|\n\r\t]', "_", n["title"]).strip() or "无标题"
        with open(os.path.join(out, "markdown", f"{i:03d}-{safe[:40]}.md"),
                  "w", encoding="utf-8") as f:
            f.write(f"---\ncolor: {n['color']}\npinned: {n['pinned']}\n"
                    f"created: {n['created_at']}\nupdated: {n['updated_at']}\n"
                    f"source_id: {n['external_id']}\n---\n\n{n['markdown']}\n")

    for ext in ("", "-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copyfile(src + ext, os.path.join(out, "raw", "plum.sqlite" + ext))
    media_dir = os.path.join(os.path.dirname(src), "media")
    if os.path.isdir(media_dir):
        shutil.copytree(media_dir, os.path.join(out, "raw", "media"), dirs_exist_ok=True)

    print(f"\n✓ 导出 {len(notes)} 条便笺 → {os.path.abspath(out)}")
    print(f"  notes.json      全保真，可直接用于导入")
    print(f"  markdown/       每条一个 .md")
    print(f"  raw/            原始库归档（你从未拥有过的备份）")
    if deleted_n:
        print(f"  · 跳过 {deleted_n} 条已删除")
    pinned = sum(1 for n in notes if n["pinned"])
    if pinned:
        print(f"  · {pinned} 条置顶（经典版数据模型里确实有 IsAlwaysOnTop）")
    ink = sum(1 for n in notes if n["has_ink"])
    if ink:
        print(f"  · ⚠ {ink} 条含手写墨迹 —— 格式私有，本脚本只标记不转换")
    if degraded_n:
        print(f"  · ⚠ {degraded_n} 条含无法识别的格式控制字，已降级为纯文本（内容未丢）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
