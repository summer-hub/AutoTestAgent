import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyHostTheme } from './theme';

// iframe 嵌入 DSH 时同步宿主主题（同源读 parent --dsw-* 变量）；独立运行自动跳过。
applyHostTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
