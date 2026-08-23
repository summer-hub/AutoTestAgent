import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyHostTheme } from './theme';

// iframe 嵌入 DSH 时同步宿主主题（同源读 parent --dsw-* 变量）；独立运行自动跳过。
applyHostTheme();
// 嵌入模式：页面背景透明，让 DSH 皮肤（背景/渐变）直接透过来，面板颜色仍由同步的 --dsw-* 变量驱动
if (import.meta.env.VITE_EMBED === '1') {
  document.body.classList.add('dsh-embed-host');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
