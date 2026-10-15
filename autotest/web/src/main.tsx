import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyHostTheme, applyTheme, loadTheme } from './theme';
import { ErrorBoundary } from './components/ErrorBoundary';

// iframe 嵌入 DSH 时同步宿主主题（同源读 parent --dsw-* 变量）；独立运行自动跳过。
applyHostTheme();
// 应用本地主题（亮/暗 + 主题色）：必须在首次 render 之前，
// 否则会先按默认（跟随宿主）渲染一帧、再切成用户选的主题——出现明显闪烁。
// 顺序也有讲究：applyHostTheme 先把宿主 --dsw-* 搬进来，applyTheme 再决定 data-theme，
// 这样 auto 模式能拿到宿主值、显式模式能被 data-theme 覆盖，两者不冲突。
applyTheme(loadTheme());
// 嵌入模式：页面背景透明，让 DSH 皮肤（背景/渐变）直接透过来，面板颜色仍由同步的 --dsw-* 变量驱动
if (import.meta.env.VITE_EMBED === '1') {
  document.body.classList.add('dsh-embed-host');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
