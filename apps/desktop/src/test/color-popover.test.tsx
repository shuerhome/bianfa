import { NOTE_COLORS } from "@bianfa/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import i18next from "i18next";
import { createRef } from "react";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import zh from "../i18n/zh-Hans.json";
import { ColorPopover } from "../windows/note/ColorPopover.js";

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh-Hans",
    resources: { "zh-Hans": { translation: zh } },
    interpolation: { escapeValue: false },
  });
});
// vitest globals: false → RTL 不自动清理，而 Popover 走 portal 挂在 body 上，必须手动清
afterEach(cleanup);

// useAnchored 在无布局的 jsdom 下保持 visibility:hidden，getByRole 的可及名算法会算空，
// 所以这里直接按 DOM 断言（aria-label 属性本身就是被测内容）。
function renderPopover(onChange = vi.fn()) {
  const anchorRef = createRef<HTMLElement>();
  render(<ColorPopover open onClose={() => {}} anchorRef={anchorRef} value="citron" onChange={onChange} />);
  return { onChange };
}
const swatchInput = (color: string) =>
  document.querySelector<HTMLInputElement>(`.color-swatch[data-color="${color}"] input[type="radio"]`);

describe("ColorPopover 色块带", () => {
  it("20 个色块都是真 radio，aria-label 带名称 + 快捷键", () => {
    renderPopover();
    const inputs = document.querySelectorAll('.color-band input[type="radio"]');
    expect(inputs).toHaveLength(NOTE_COLORS.length);
    // 石墨 = Ctrl/Cmd+Shift+0；柠檬是浅色档第 5 个 → Ctrl/Cmd+4；橄榄是浓色档第 5 个 → Ctrl/Cmd+Shift+4
    expect(swatchInput("graphite")?.getAttribute("aria-label")).toMatch(/^石墨 · .*0$/);
    expect(swatchInput("citron")?.getAttribute("aria-label")).toMatch(/^柠檬 · .*4$/);
    expect(swatchInput("olive")?.getAttribute("aria-label")).toMatch(/^橄榄 · .*4$/);
    // 墨灰没有快捷键（Ctrl/Cmd+Shift+0 已经归石墨），aria-label 只有名字
    expect(swatchInput("slate")?.getAttribute("aria-label")).toBe("墨灰");
    // 单选组：同名，才有原生方向键行为
    const names = new Set([...inputs].map((el) => (el as HTMLInputElement).name));
    expect(names.size).toBe(1);
  });

  it("选中的块画对勾，其余不画", () => {
    renderPopover();
    const selected = document.querySelectorAll(".color-swatch--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-color")).toBe("citron");
    expect(document.querySelectorAll(".color-swatch__check")).toHaveLength(1);
  });

  it("说明行常驻：无悬停时是当前选中色，悬停时切到该色", () => {
    renderPopover();
    const caption = document.querySelector(".color-caption");
    expect(caption?.textContent).toContain("柠檬");
    expect(caption?.textContent).toContain("当前");

    const fern = document.querySelector<HTMLElement>('.color-swatch[data-color="fern"]');
    if (!fern) throw new Error("竹绿色块缺失");
    fireEvent.pointerEnter(fern);
    expect(caption?.textContent).toContain("竹绿");
    expect(caption?.textContent).not.toContain("当前");
  });

  it("两档各 10 格，中间有分隔与档位标题", () => {
    renderPopover();
    const bands = document.querySelectorAll(".color-band");
    expect(bands).toHaveLength(2);
    for (const band of bands) expect(band.querySelectorAll('input[type="radio"]')).toHaveLength(10);
    expect([...document.querySelectorAll(".color-tier__label")].map((el) => el.textContent)).toEqual([
      "浅色",
      "浓色",
    ]);
  });

  it("点选浓色档的色块也回调新颜色", () => {
    const { onChange } = renderPopover();
    const eggplant = swatchInput("eggplant");
    if (!eggplant) throw new Error("茄紫色块缺失");
    fireEvent.click(eggplant);
    expect(onChange).toHaveBeenCalledWith("eggplant");
  });

  it("点选色块回调新颜色", () => {
    const { onChange } = renderPopover();
    const fern = swatchInput("fern");
    if (!fern) throw new Error("竹绿色块缺失");
    fireEvent.click(fern);
    expect(onChange).toHaveBeenCalledWith("fern");
  });
});
