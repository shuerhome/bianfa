// React 里唯一能拦住渲染期异常的东西还是 class 组件（没有 hook 版本）。
//
// 直接的用途：懒加载的编辑器分块取不到时（离线、发版后旧 index.html 指着已经删掉的文件），
// React.lazy 抛出的是一个**渲染期**异常。没有边界的话整棵树被卸载，用户看到的是一张纯白页面——
// 而且 lazy 会把那次失败缓存下来，重新渲染也救不回来，只能整页刷新。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台是这里唯一的去处：网页端没有日志通道，而吞掉异常比白屏更难查
    console.error("[bianfa] 渲染失败", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // 重试只能是整页刷新：React.lazy 会记住那次失败的 import，清 state 也不会重新去取
    return this.props.fallback(() => window.location.reload());
  }
}
