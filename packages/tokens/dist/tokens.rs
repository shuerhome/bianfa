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
    Rgb { r: 229, g: 227, b: 217 }, // graphite
    Rgb { r: 248, g: 218, b: 227 }, // rose
    Rgb { r: 248, g: 219, b: 215 }, // coral
    Rgb { r: 248, g: 222, b: 195 }, // amber
    Rgb { r: 235, g: 231, b: 164 }, // citron
    Rgb { r: 198, g: 240, b: 198 }, // fern
    Rgb { r: 174, g: 242, b: 235 }, // teal
    Rgb { r: 203, g: 232, b: 248 }, // azure
    Rgb { r: 225, g: 224, b: 248 }, // violet
    Rgb { r: 248, g: 214, b: 246 }, // fuchsia
];
pub const NOTE_PAPER_DARK: [Rgb; 10] = [
    Rgb { r: 44, g: 43, b: 40 }, // graphite
    Rgb { r: 66, g: 29, b: 43 }, // rose
    Rgb { r: 69, g: 30, b: 26 }, // coral
    Rgb { r: 59, g: 38, b: 14 }, // amber
    Rgb { r: 47, g: 45, b: 17 }, // citron
    Rgb { r: 27, g: 50, b: 28 }, // fern
    Rgb { r: 26, g: 48, b: 46 }, // teal
    Rgb { r: 17, g: 47, b: 62 }, // azure
    Rgb { r: 42, g: 38, b: 71 }, // violet
    Rgb { r: 59, g: 32, b: 58 }, // fuchsia
];
pub const NOTE_DOT_LIGHT: [Rgb; 10] = [
    Rgb { r: 119, g: 117, b: 108 }, // graphite
    Rgb { r: 191, g: 59, b: 116 }, // rose
    Rgb { r: 198, g: 61, b: 52 }, // coral
    Rgb { r: 154, g: 104, b: 45 }, // amber
    Rgb { r: 124, g: 119, b: 51 }, // citron
    Rgb { r: 69, g: 134, b: 73 }, // fern
    Rgb { r: 73, g: 128, b: 123 }, // teal
    Rgb { r: 50, g: 126, b: 161 }, // azure
    Rgb { r: 115, g: 93, b: 211 }, // violet
    Rgb { r: 168, g: 70, b: 167 }, // fuchsia
];
pub const NOTE_DOT_DARK: [Rgb; 10] = [
    Rgb { r: 161, g: 159, b: 147 }, // graphite
    Rgb { r: 228, g: 116, b: 158 }, // rose
    Rgb { r: 235, g: 119, b: 106 }, // coral
    Rgb { r: 208, g: 143, b: 64 }, // amber
    Rgb { r: 169, g: 162, b: 72 }, // citron
    Rgb { r: 110, g: 177, b: 112 }, // fern
    Rgb { r: 101, g: 174, b: 167 }, // teal
    Rgb { r: 71, g: 170, b: 217 }, // azure
    Rgb { r: 155, g: 144, b: 236 }, // violet
    Rgb { r: 206, g: 123, b: 204 }, // fuchsia
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
