// 自动生成（pnpm -F @bianfa/tokens build），勿手改；来源 packages/tokens/src/tokens.json
// 供 src-tauri 用 include!() 引入：托盘角标、窗口 background_color（alpha 恒 255）。
// 用法：#[allow(dead_code)] mod tokens { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/tokens/dist/tokens.rs")); }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn to_array(self) -> [u8; 3] {
        [self.r, self.g, self.b]
    }
    pub const fn to_rgba(self) -> [u8; 4] {
        [self.r, self.g, self.b, 255]
    }
}

/// 10 色枚举名，顺序 = 换色快捷键顺序（0 = Ctrl/Cmd+Shift+0，1..9 = Ctrl/Cmd+1..9）
pub const NOTE_COLORS: [&str; 10] = ["graphite", "rose", "coral", "amber", "citron", "fern", "teal", "azure", "violet", "fuchsia"];
pub const DEFAULT_NOTE_COLOR: &str = "graphite";

pub const NOTE_PAPER_LIGHT: [Rgb; 10] = [
    Rgb { r: 246, g: 245, b: 241 }, // graphite
    Rgb { r: 255, g: 239, b: 244 }, // rose
    Rgb { r: 255, g: 236, b: 233 }, // coral
    Rgb { r: 255, g: 238, b: 220 }, // amber
    Rgb { r: 253, g: 251, b: 206 }, // citron
    Rgb { r: 222, g: 255, b: 222 }, // fern
    Rgb { r: 201, g: 255, b: 249 }, // teal
    Rgb { r: 224, g: 244, b: 255 }, // azure
    Rgb { r: 240, g: 239, b: 255 }, // violet
    Rgb { r: 255, g: 234, b: 253 }, // fuchsia
];
pub const NOTE_PAPER_DARK: [Rgb; 10] = [
    Rgb { r: 37, g: 36, b: 33 }, // graphite
    Rgb { r: 52, g: 32, b: 39 }, // rose
    Rgb { r: 51, g: 30, b: 27 }, // coral
    Rgb { r: 47, g: 33, b: 18 }, // amber
    Rgb { r: 39, g: 37, b: 17 }, // citron
    Rgb { r: 26, g: 41, b: 26 }, // fern
    Rgb { r: 13, g: 42, b: 40 }, // teal
    Rgb { r: 18, g: 39, b: 50 }, // azure
    Rgb { r: 35, g: 34, b: 52 }, // violet
    Rgb { r: 45, g: 30, b: 44 }, // fuchsia
];
pub const NOTE_DOT_LIGHT: [Rgb; 10] = [
    Rgb { r: 106, g: 105, b: 100 }, // graphite
    Rgb { r: 220, g: 81, b: 138 }, // rose
    Rgb { r: 217, g: 74, b: 63 }, // coral
    Rgb { r: 195, g: 121, b: 0 }, // amber
    Rgb { r: 153, g: 144, b: 1 }, // citron
    Rgb { r: 26, g: 156, b: 49 }, // fern
    Rgb { r: 0, g: 157, b: 148 }, // teal
    Rgb { r: 0, g: 148, b: 199 }, // azure
    Rgb { r: 135, g: 113, b: 238 }, // violet
    Rgb { r: 185, g: 82, b: 183 }, // fuchsia
];
pub const NOTE_DOT_DARK: [Rgb; 10] = [
    Rgb { r: 157, g: 155, b: 150 }, // graphite
    Rgb { r: 219, g: 106, b: 149 }, // rose
    Rgb { r: 238, g: 120, b: 107 }, // coral
    Rgb { r: 223, g: 143, b: 34 }, // amber
    Rgb { r: 179, g: 169, b: 26 }, // citron
    Rgb { r: 87, g: 177, b: 93 }, // fern
    Rgb { r: 1, g: 189, b: 179 }, // teal
    Rgb { r: 0, g: 179, b: 240 }, // azure
    Rgb { r: 157, g: 144, b: 247 }, // violet
    Rgb { r: 211, g: 126, b: 208 }, // fuchsia
];

pub const CANVAS_LIGHT: Rgb = Rgb { r: 252, g: 252, b: 251 };
pub const CANVAS_DARK: Rgb = Rgb { r: 19, g: 19, b: 18 };
pub const SURFACE_1_LIGHT: Rgb = Rgb { r: 252, g: 252, b: 251 };
pub const SURFACE_1_DARK: Rgb = Rgb { r: 26, g: 26, b: 24 };
pub const ACCENT_LIGHT: Rgb = Rgb { r: 76, g: 95, b: 213 };
pub const ACCENT_DARK: Rgb = Rgb { r: 142, g: 155, b: 245 };
pub const WARNING_LIGHT: Rgb = Rgb { r: 138, g: 90, b: 0 };
pub const WARNING_DARK: Rgb = Rgb { r: 217, g: 162, b: 46 };
pub const DANGER_LIGHT: Rgb = Rgb { r: 192, g: 54, b: 44 };
pub const DANGER_DARK: Rgb = Rgb { r: 240, g: 115, b: 106 };

/// 色名 → 序号；未知 → None
pub fn note_color_index(name: &str) -> Option<usize> {
    NOTE_COLORS.iter().position(|c| *c == name)
}

/// 便笺纸面色（= 窗口底色）。未知色名按 graphite。
pub fn note_paper(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_PAPER_DARK[i] } else { NOTE_PAPER_LIGHT[i] }
}

/// 便笺色点（托盘「最近」项的色标）。未知色名按 graphite。
pub fn note_dot(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_DOT_DARK[i] } else { NOTE_DOT_LIGHT[i] }
}

pub fn canvas(dark: bool) -> Rgb {
    if dark { CANVAS_DARK } else { CANVAS_LIGHT }
}
