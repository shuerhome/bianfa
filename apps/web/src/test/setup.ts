// jsdom 测试环境：同步初始化 i18n（zh-Hans）；globals: false 时 Testing Library 不会自动 cleanup，这里显式挂上
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initI18n } from "../i18n.js";

initI18n("zh-Hans");
afterEach(() => cleanup());
if (!("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });
}
