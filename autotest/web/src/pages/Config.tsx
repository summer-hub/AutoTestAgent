import { useState } from 'react';
import SettingsPage from '../views/Settings';
import PromptsPage from '../views/Prompts';
import AgentBindingsPage from '../views/AgentBindings';
import AnalysisPage from '../views/Analysis';

/**
 * 配置页（R8 Phase 2c）—— 平台配置与跨库分析的统一入口。
 *
 * 产品动机：设置 / Prompt / Agent 绑定 / 数据分析原先散落在「资源与配置」和
 * 「智能分析」两个分组里。四者的共性都是"平台级"的——不针对某一个库，
 * 而是配置整个平台怎么工作、或从全局视角看数据。收成一个页面的 4 个 Tab。
 */
type Tab = 'settings' | 'prompts' | 'agents' | 'analysis';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'settings', label: '系统设置', icon: '⚙️' },
  { key: 'prompts', label: 'Prompt', icon: '🧠' },
  { key: 'agents', label: 'Agent 绑定', icon: '🔗' },
  { key: 'analysis', label: '数据分析', icon: '📊' },
];

export default function ConfigPage() {
  const [tab, setTab] = useState<Tab>('settings');

  return (
    <>
      <div className="page-title">配置</div>
      <div className="page-desc">
        平台级配置与全局数据分析 —— 系统设置、Agent 提示词模板、Agent 绑定，
        以及跨库的执行与用例统计。
      </div>

      <div className="ws-tabs" style={{ borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`ws-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="ico">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {tab === 'settings' && <SettingsPage />}
      {tab === 'prompts' && <PromptsPage />}
      {tab === 'agents' && <AgentBindingsPage />}
      {tab === 'analysis' && <AnalysisPage />}
    </>
  );
}
