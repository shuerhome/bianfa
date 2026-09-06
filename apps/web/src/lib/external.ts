// 整页离开当前站点（回到桌面端 loopback / 第三方登录页）。独立成模块便于测试里 mock。
export function leaveTo(url: string): void {
  window.location.assign(url);
}
