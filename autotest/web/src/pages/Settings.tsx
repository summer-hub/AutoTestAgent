import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface SettingItem { key: string; value: string | number | boolean | null; updatedAt: string | null }
interface ShardStat { shard: number; libraries: number; cases: number }

const SECTIONS: Array<{ title: string; desc: string; fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'bool'; hint?: string }> }> = [
  {
    title: '通用', desc: '基础工作区与默认规模', fields: [
      { key: 'app.workspace', label: '工作区路径', type: 'text' },
      { key: 'app.defaultCasesPerLib', label: '默认每库用例数', type: 'number' },
    ],
  },
  {
    title: 'Agent 与任务', desc: 'AI 任务执行参数', fields: [
      { key: 'agent.defaultModel', label: '默认模型', type: 'text' },
      { key: 'agent.maxCasesPerTask', label: '单任务用例上限', type: 'number' },
      { key: 'exec.llmTemperature', label: 'LLM 温度（0-1）', type: 'number' },
      { key: 'exec.llmTimeoutMs', label: 'LLM 超时（毫秒）', type: 'number' },
    ],
  },
  {
    title: '执行计划', desc: '各类计划的抽样规模（演示上限）', fields: [
      { key: 'exec.scriptMode', label: '脚本执行模式', type: 'text', hint: 'script（绑定脚本优先）/ step（始终用例步骤）' },
      { key: 'exec.planSampleFull', label: '全量计划抽样', type: 'number' },
      { key: 'exec.planSampleBatch', label: '批量计划抽样', type: 'number' },
      { key: 'exec.planSampleSingle', label: '单独计划抽样', type: 'number' },
    ],
  },
  {
    title: '数据与缓存（M7）', desc: 'Redis 缓存与分表', fields: [
      { key: 'data.redisCache', label: '启用 Redis 缓存', type: 'bool' },
      { key: 'data.redisUrl', label: 'Redis URL（留空走内存 LRU）', type: 'text' },
      { key: 'data.cacheTtlSeconds', label: '缓存 TTL（秒）', type: 'number' },
      { key: 'data.shardCount', label: '用例分表数', type: 'number' },
    ],
  },
  {
    title: '设备与执行', desc: '设备执行引擎', fields: [
      { key: 'device.execEngine', label: '执行引擎', type: 'text' },
      { key: 'device.appAbilities', label: '应用启动映射（JSON）', type: 'text', hint: '{"时钟":"com.xx/.MainAbility"}' },
      { key: 'exec.scriptMode', label: '脚本执行模式', type: 'text', hint: 'script / step' },
    ],
  },
];

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [shards, setShards] = useState<ShardStat[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.settings()
      .then((rows) => {
        const map: Record<string, string | number | boolean> = {};
        for (const r of rows) if (r.value !== null) map[r.key] = r.value as string | number | boolean;
        setValues(map);
        setLoaded(true);
      })
      .catch((e) => setError(String((e as Error).message)));
    api.sharding().then(setShards).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true); setMsg(''); setError('');
    try {
      for (const [key, value] of Object.entries(values)) {
        await api.updateSetting(key, value);
      }
      setMsg('配置已保存，立即生效');
      load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div className="card muted" style={{ padding: 28 }}>加载配置中…</div>;

  return (
    <>
      <div className="page-title">系统配置</div>
      <div className="page-desc">
        仿 DSH 风格的基本功能配置：AI 任务 / 执行计划 / 数据缓存与分表 / 设备执行（模型管理复用 DSH 设置 → 模型）
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存全部配置'}</button>
      </div>

      {SECTIONS.map((sec) => (
        <div key={sec.title} className="card" style={{ marginBottom: 14 }}>
          <div className="card-h">
            <span className="t">{sec.title}</span>
            <span className="sub">{sec.desc}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {sec.fields.map((f) => (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {f.label}
                  <span style={{ color: 'var(--text3)' }}> · {f.key}</span>
                </span>
                {f.type === 'bool' ? (
                  <select
                    className="select"
                    value={values[f.key] === true ? 'true' : 'false'}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value === 'true' }))}
                  >
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                ) : (
                  <input
                    className="input"
                    type={f.type}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <div className="card-h">
          <span className="t">🗄️ 分表统计（M7 · library_id % {values['data.shardCount'] ?? 16}）</span>
          <span className="sub">生产 MySQL 按 cases_{'{'}shard{'}'} 物理分表，SQLite 开发单表但路由一致</span>
        </div>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>分片</th><th>库数</th><th>用例数</th></tr></thead>
            <tbody>
              {shards.map((s) => (
                <tr key={s.shard}><td>shard-{s.shard}</td><td>{s.libraries}</td><td>{s.cases}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
