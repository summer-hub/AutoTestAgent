// 全局错误边界：任何页面渲染异常都不再白屏，给出可操作的恢复入口
import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; resetKey?: string }
interface State { err: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error): void {
    // eslint-disable-next-line no-console
    console.error('[ui] 页面渲染异常：', err);
  }

  componentDidUpdate(prev: Props): void {
    // 切换页面后自动清除错误状态
    if (prev.resetKey !== this.props.resetKey && this.state.err) {
      this.setState({ err: null });
    }
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <div className="card" style={{ margin: 40, padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>😵</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>页面出了点问题，已阻止白屏</div>
          <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 16, wordBreak: 'break-all' }}>
            {this.state.err.message}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="btn" onClick={() => this.setState({ err: null })}>重试</button>
            <button className="btn primary" onClick={() => window.location.reload()}>刷新页面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
