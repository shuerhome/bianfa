// jsdom 测试环境：同步初始化 i18n（zh-Hans）；globals: false 时 Testing Library 不会自动 cleanup，这里显式挂上
import { configure } from "@testing-library/dom";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initI18n } from "../i18n.js";

// waitFor 的默认预算是 1 秒，而这里好几个用例在机器空闲时就要跑 1.4~2.0 秒
// （渲染 + 若干次 waitFor 串起来）。turbo 把四个包的测试并行跑起来时整套慢约 4 倍，
// 那 1 秒就会被越过——表现是随机某一条失败、单独重跑又是绿的。
// 放宽的是"等多久算超时"，不是断言本身：真的坏了照样红，只是晚一点。
configure({ asyncUtilTimeout: 5000 });

initI18n("zh-Hans");
afterEach(() => cleanup());
if (!("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });
}
