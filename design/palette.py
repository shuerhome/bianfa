#!/usr/bin/env python3
"""淡彩纸色板生成器与校验器 —— 零依赖。

复现第 12 章的两条规则并自我校验：
  1. 10 色便笺纸锁在同一 OKLCH 明度（亮 L=0.915 / 暗 L=0.290）
  2. 失焦「退半步」色 = L+0.006, C×0.80

用法：python3 design/palette.py
"""
import math

# ── sRGB ⇄ OKLab ────────────────────────────────────────────────────────────
def _s2l(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def _l2s(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

_M1  = [[.4122214708, .5363325363, .0514459929],
        [.2119034982, .6806995451, .1073969566],
        [.0883024619, .2817188376, .6299787005]]
_M2  = [[.2104542553, .7936177850, -.0040720468],
        [1.9779984951, -2.4285922050, .4505937099],
        [.0259040371, .7827717662, -.8086757660]]
_M1i = [[1, .3963377774, .2158037573], [1, -.1055613458, -.0638541728], [1, -.0894841775, -1.2914855480]]
_M2i = [[4.0767416621, -3.3077115913, .2309699292],
        [-1.2684380046, 2.6097574011, -.3413193965],
        [-.0041960863, -.7034186147, 1.7076147010]]

def _mul(M, v): return [sum(M[i][j] * v[j] for j in range(3)) for i in range(3)]

def hex_to_oklch(h):
    h = h.lstrip('#')
    rgb = [_s2l(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    lms = [x ** (1 / 3) if x >= 0 else -(-x) ** (1 / 3) for x in _mul(_M1, rgb)]
    L, a, b = _mul(_M2, lms)
    return L, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360

def oklch_to_hex(L, C, H):
    a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
    lms = [x ** 3 for x in _mul(_M1i, [L, a, b])]
    return '#%02X%02X%02X' % tuple(
        round(max(0, min(1, _l2s(x))) * 255) for x in _mul(_M2i, lms))

def dim(paper_hex):
    """失焦「退半步」色：L+0.006, C×0.80。不用 filter —— 那会给每个窗口建独立渲染面。"""
    L, C, H = hex_to_oklch(paper_hex)
    return oklch_to_hex(L + 0.006, C * 0.80, H)

# ── WCAG 2.x 对比度 ─────────────────────────────────────────────────────────
def _lum(h):
    h = h.lstrip('#')
    r, g, b = [_s2l(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    return .2126 * r + .7152 * g + .0722 * b

def contrast(a, b):
    x, y = _lum(a), _lum(b)
    hi, lo = max(x, y), min(x, y)
    return (hi + .05) / (lo + .05)

# ── 色板（paper, ink, ink2, line, dot）───────────────────────────────────────
LIGHT = {
    "石墨":   ("#E5E3D9", "#2F2E2A", "#646360", "#CECCC3", "#77756C"),
    "玫瑰":   ("#F8DAE3", "#42232E", "#765A63", "#DFC4CC", "#BF3B74"),
    "珊瑚":   ("#F8DBD7", "#44241F", "#785B57", "#DFC5C2", "#C63D34"),
    "琥珀":   ("#F8DEC3", "#3E2910", "#725F4C", "#DFC8B0", "#9A682D"),
    "柠檬":   ("#EBE7A4", "#312F12", "#66654D", "#D3D095", "#7C7733"),
    "竹绿":   ("#C6F0C6", "#213321", "#596859", "#B3D8B3", "#458649"),
    "松石":   ("#AEF2EB", "#1B3331", "#516966", "#9EDAD3", "#49807B"),
    "天青":   ("#CBE8F8", "#123241", "#4D6775", "#B7D1DF", "#327EA1"),
    "紫罗兰": ("#E1E0F8", "#2D2A45", "#626078", "#CBCADF", "#735DD3"),
    "品红":   ("#F8D6F6", "#3B243A", "#705C6E", "#DFC1DD", "#A846A7"),
}
FOCUS_LIGHT = "#4C5FD5"

# 规范正文里给出的唯一一个 dim 例子，用作生成器的黄金测试
GOLDEN = ("#EBE7A4", "#EBE8B3")


def main():
    print("── 生成器 ──")
    print(f"{'色':8s} {'paper':9s} {'L':>6s} {'C':>6s}   {'dim':9s}")
    for n, (p, *_rest) in LIGHT.items():
        L, C, _ = hex_to_oklch(p)
        print(f"{n:8s} {p}  {L:.4f} {C:.4f}   {dim(p)}")

    ok = True

    got = dim(GOLDEN[0])
    good = got == GOLDEN[1]
    ok &= good
    print(f"\n[1] 黄金测试 · 柠檬 {GOLDEN[0]} → 期望 {GOLDEN[1]}，实得 {got}  "
          + ("✅" if good else "❌"))

    Ls = [hex_to_oklch(v[0])[0] for v in LIGHT.values()]
    spread = max(Ls) - min(Ls)
    good = spread < 0.005
    ok &= good
    print(f"[2] 明度锁定 · 极差 {spread:.4f}（应 < 0.005）  " + ("✅" if good else "❌"))

    print("\n── 对比度（WCAG 2.x）──")
    rows = {"ink/paper": [], "ink2/paper": [], "dot/paper": [], "focus/paper": []}
    for p, ink, ink2, _line, dot in LIGHT.values():
        rows["ink/paper"].append(contrast(ink, p))
        rows["ink2/paper"].append(contrast(ink2, p))
        rows["dot/paper"].append(contrast(dot, p))
        rows["focus/paper"].append(contrast(FOCUS_LIGHT, p))

    # 按对类分级门禁 —— 统一 4.5 会让规范自己的合法值（禁用态 3.30、色点 3.50、边框 1.6）全部失败
    GATES = {"ink/paper": 10.0, "ink2/paper": 4.5, "dot/paper": 3.0, "focus/paper": 3.0}
    for k, v in rows.items():
        good = min(v) >= GATES[k]
        ok &= good
        print(f"{k:12s} {min(v):5.2f}–{max(v):5.2f}:1   门禁 ≥{GATES[k]:<5}  "
              + ("✅" if good else "❌"))

    print("\n" + ("✅ 全部通过" if ok else "❌ 存在未达标项"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
