import { useState } from 'react';
import PlansPage from '../views/Plans';
import TasksPage from '../views/Tasks';
import DevicesPage from '../views/Devices';
import DebugPage from '../views/Debug';

/**
 * 执行页（R8 Phase 2b）—— 「现在什么在跑」的统一视图。
 *
 * 产品动机：执行相关的四个页面（计划/任务/设备/调试）原先散落在两个导航分组里，
 * 用户的真实任务是"发起一次执行 → 看它跑到哪 → 失败了看轨迹 → 换台设备重跑"，
 * 这条路被切成 4 个页面。这里收成一个页面的 4 个 Tab。
 *
 * 调试会话（Debug）由此从独立页面降级为页内视图——它的定位本来就是
 * "某次执行的轨迹与 AI 思考"，不该占据一级导航。
 */
type Tab = 'plans' | 'tasks' | 'devices' | 'debug';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'plans', label: '执行计划', icon: '📅' },
  { key: 'tasks', label: '任务', icon: '📋' },
  { key: 'devices', label: '设备', icon: '📱' },
  { key: 'debug', label: '调试会话', icon: '🐞' },
];

export default function ExecutionPage() {
  const [tab, setTab] = useState<Tab>('plans');

  return (
    <>
      <div className="page-title">执行</div>
      <div className="page-desc">
        执行计划、AI 任务、真机设备与调试轨迹。严格真机执行——设备未连接时计划直接失败并写明原因，
        不会回退模拟。
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

      {tab === 'plans' && <PlansPage />}
      {tab === 'tasks' && <TasksPage />}
      {tab === 'devices' && <DevicesPage />}
      {tab === 'debug' && <DebugPage />}
    </>
  );
}
