// jsdom 测试环境：同步初始化 i18n（zh-Hans），屏蔽 scrollIntoView 等缺省实现
import { initI18n } from "../i18n.js";

initI18n("zh-Hans");
if (!("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });
}
