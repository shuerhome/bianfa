#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""export_sticky_notes.py 的自测：按已核实的 DDL 造合成 plum.sqlite 再跑一遍。

    python3 tools/test_export_sticky_notes.py

无需 Windows、无需真实便笺数据。覆盖 18 列与 19 列两个变体
（列漂移是实测事实：HTB 取证样本 18 列，mobiusft 查询 19 列）。
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORTER = os.path.join(HERE, "export_sticky_notes.py")


def ticks(ms):
    return (ms + 62135596800000) * 10000


def build(path, extra_col):
    c = sqlite3.connect(path)
    extra = ', "PendingInsightsScan" integer' if extra_col else ""
    c.execute(f'''CREATE TABLE "Note"(
      "Text" varchar, "WindowPosition" varchar, "IsOpen" integer, "IsAlwaysOnTop" integer,
      "CreationNoteIdAnchor" varchar, "Theme" varchar, "IsFutureNote" integer, "RemoteId" varchar,
      "ChangeKey" varchar, "LastServerVersion" varchar, "RemoteSchemaVersion" integer,
      "IsRemoteDataInvalid" integer, "Type" varchar, "Id" varchar primary key not null,
      "ParentId" varchar, "CreatedAt" bigint, "DeletedAt" bigint, "UpdatedAt" bigint{extra})''')
    c.execute('CREATE TABLE "Media"("Id" varchar primary key,"ParentId" varchar,"MimeType" varchar,'
              '"LocalFileRelativePath" varchar,"CreatedAt" bigint,"UpdatedAt" bigint)')
    c.execute('CREATE TABLE "Stroke"("Id" varchar primary key,"ParentId" varchar)')
    c.execute('CREATE TABLE "Insight"("Id" varchar primary key)')
    c.execute('CREATE TABLE "User"("Id" varchar primary key)')

    server_json = json.dumps({"document": {"blocks": [
        {"content": [{"text": "服务器续费"}, {"text": "Hostinger KVM 4 到期 11/20"}]}]}})
    rows = [
        # 私有 Text 格式：\id 前缀 + RTF 风格控制字 + \par 分段
        (r'\id=8f14e45f-ceea-467a-9b0a-1c2d3e4f5a6b 周三 14:00 \b产品评审\b0\par确认 OKLCH 色板 v2.3\par\i下周补 macOS 验证\i0',
         'ManagedPosition=DeviceId:{DISPLAY1};Position=340,180;Size=320,320', 1, 1, None,
         'Yellow', 0, None, None, None, 0, 0, None, 'n-001', None,
         ticks(1756000000000), None, ticks(1756800000000)),
        # 负坐标：多显示器左侧屏。用 \d+ 的正则会静默漏掉这批用户
        (r'\id=aaaa1111-2222-3333-4444-555566667777 取快递\par丰巢 8-2211，取件码 4471',
         'ManagedPosition=DeviceId:{DISPLAY2};Position=-1600,-240;Size=180,140', 1, 0, None,
         'Pink', 0, None, None, None, 0, 0, None, 'n-002', None,
         ticks(1755000000000), None, ticks(1755500000000)),
        # 已同步：LastServerVersion 是富文本真源，必须优先于 Text
        (r'\id=bbbb 这段应该被忽略',
         'ManagedPosition=DeviceId:{DISPLAY1};Position=900,120;Size=220,260', 0, 0, None,
         'Blue', 0, 'remote-1', 'ck-1', server_json, 3, 0, None, 'n-003', None,
         ticks(1754000000000), None, ticks(1756100000000)),
        # 已删除：应被跳过
        (r'\id=cccc 这条已删除', None, 0, 0, None, 'Green', 0, None, None, None, 0, 0, None,
         'n-004', None, ticks(1753000000000), ticks(1756000000000), ticks(1756000000000)),
        # 未知 Theme + 未知控制字：应降级但不丢内容
        (r'\id=dddd 买菜\par\zzz西红柿 2 斤\par\strike已买\strike0 牛奶', None, 1, 0, None,
         'Teal', 0, None, None, None, 0, 0, None, 'n-005', None,
         ticks(1752000000000), None, ticks(1752500000000)),
    ]
    if extra_col:
        rows = [r + (0,) for r in rows]
    c.executemany(f'INSERT INTO "Note" VALUES({",".join("?" * len(rows[0]))})', rows)
    c.execute('INSERT INTO "Media" VALUES(?,?,?,?,?,?)',
              ('m1', 'n-001', 'image/png', 'media/abc123.png', 0, 0))
    c.execute('INSERT INTO "Stroke" VALUES(?,?)', ('s1', 'n-002'))
    c.commit()
    c.close()


CASES = [
    ("\\par 全部转成换行（\\s? 会连换行一起吞掉，分隔符只能是空格/制表符）",
     lambda b: b["n-001"]["markdown"] ==
     "周三 14:00 **产品评审**\n确认 OKLCH 色板 v2.3\n*下周补 macOS 验证*"),
    ("\\id= 前缀已剥离", lambda b: all("\\id=" not in n["markdown"] for n in b.values())),
    ("\\b → **粗体**", lambda b: "**产品评审**" in b["n-001"]["markdown"]),
    ("\\i → *斜体*", lambda b: "*下周补 macOS 验证*" in b["n-001"]["markdown"]),
    # RTF 里 \strike0 后面那个空格是控制字分隔符，被吃掉是正确行为
    ("\\strike → ~~删除线~~ 且分隔符语义正确",
     lambda b: b["n-005"]["markdown"] == "买菜\n西红柿 2 斤\n~~已买~~牛奶"),
    ("未知控制字丢弃而非原样显示，且打降级标记",
     lambda b: "\\zzz" not in b["n-005"]["markdown"]
     and "西红柿 2 斤" in b["n-005"]["markdown"] and b["n-005"]["import_degraded"]),
    ("负坐标解析正确", lambda b: b["n-002"]["window"] ==
     {"x": -1600, "y": -240, "w": 180, "h": 140, "display_id": "{DISPLAY2}"}),
    ("LastServerVersion 优先于 Text",
     lambda b: b["n-003"]["content_source"] == "LastServerVersion"
     and "服务器续费" in b["n-003"]["text"] and "应该被忽略" not in b["n-003"]["text"]),
    ("已删除的便笺被跳过", lambda b: "n-004" not in b),
    ("IsAlwaysOnTop 迁移为 pinned",
     lambda b: b["n-001"]["pinned"] and not b["n-002"]["pinned"]),
    ("Theme 映射 + 未知值兜底",
     lambda b: b["n-001"]["color"] == "citron" and b["n-005"]["color"] == "citron"),
    (".NET ticks 换算落在合理年份", lambda b: b["n-001"]["created_at"].startswith("2025-")),
    ("Media 归属正确",
     lambda b: b["n-001"]["attachments"][0]["path"] == "media/abc123.png"),
    ("Stroke 只标记不转换",
     lambda b: b["n-002"]["has_ink"] and not b["n-001"]["has_ink"]),
    ("标题只取首行", lambda b: b["n-001"]["title"] == "周三 14:00 产品评审"),
]


def run(extra_col):
    label = "19 列（含 PendingInsightsScan）" if extra_col else "18 列"
    with tempfile.TemporaryDirectory() as td:
        db = os.path.join(td, "plum.sqlite")
        build(db, extra_col)
        out = os.path.join(td, "out")
        r = subprocess.run([sys.executable, EXPORTER, "--db", db, "--out", out],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"✗ {label}：导出器退出码 {r.returncode}\n{r.stderr}")
            return False
        data = json.load(open(os.path.join(out, "notes.json"), encoding="utf-8"))
        by = {n["external_id"]: n for n in data["notes"]}
        ok = True
        for name, fn in CASES:
            try:
                passed = bool(fn(by))
            except Exception as e:
                passed = False
                name += f"  ({type(e).__name__}: {e})"
            if not passed:
                print(f"  ❌ {name}")
                ok = False
        print(f"{'✅' if ok else '❌'} {label} 变体：{len(CASES)} 项"
              f"{'全过' if ok else '有失败'}")
        return ok


if __name__ == "__main__":
    raise SystemExit(0 if all([run(False), run(True)]) else 1)
