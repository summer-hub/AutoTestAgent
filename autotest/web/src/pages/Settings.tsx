import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface SettingItem { key: string; value: string | number | boolean | null; updatedAt: string | null }
interface ShardStat { shard: number; libraries: number; cases: number }

const SECTIONS: Array<{ title: string; desc: string; fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'bool'; hint?: string }> }> = [
  {
    title: '通用', desc: '基础工作区与默认规模', fields: [
      { key: 'app.workspace', label: '工作区路径', type: 'text' },
    ],
  },
  {
    title: 'Agent 与任务', desc: 'AI 任务执行参数', fields: [
      { key: 'agent.defaultModel', label: '默认模型', type: 'text', hint: '留空 = 跟随 DSH 当前默认模型' },
      { key: 'agent.maxCasesPerTask', label: '单任务用例上限', type: 'number' },
      { key: 'agent.caseReviewRounds', label: '用例自审进化轮次', type: 'number', hint: '0-4，生成后评审 Agent 自动修订（真实可操作/逻辑合理/预期清晰），教训沉淀复用' },
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
      { key: 'device.autoScanInterval', label: '设备自动检测间隔（秒）', type: 'number', hint: '0=关闭；启动时立即检测一次，此后按间隔自动维护在线状态' },
      { key: 'device.appAbilities', label: '应用启动映射（JSON）', type: 'text', hint: '{"时钟":"com.xx/.MainAbility"}' },
      { key: 'exec.scriptMode', label: '脚本执行模式', type: 'text', hint: 'script / step' },
    ],
  },
  {
    title: '真机遍历', desc: 'UI 遍历引擎参数（任务页「真机遍历生成用例」执行时生效）', fields: [
      { key: 'explore.maxDepth', label: '遍历深度', type: 'number', hint: 'BFS 最大层级，1-6，默认 2' },
      { key: 'explore.maxPages', label: '页面数上限', type: 'number', hint: '最多收录页面数，1-200，默认 20' },
      { key: 'explore.controlsPerPage', label: '每页控件数上限', type: 'number', hint: '每页最多收集可交互控件，1-50，默认 12' },
      { key: 'explore.maxSwipePerPage', label: '单页滑动次数上限', type: 'number', hint: '为看全越界动画/内容最多滑动次数，0-20，默认 5' },
      { key: 'explore.statusBarFilter', label: '状态栏过滤', type: 'bool', hint: '按系统 bundleName 子树丢弃 + 高度阈值兜底' },
      { key: 'explore.systemBundles', label: '系统窗口包名清单', type: 'text', hint: '逗号分隔，追加到内置清单（sceneboard/systemui 等）' },
    ],
  },
  {
    title: '多用户 / 服务器', desc: '认证与权限（auth_* 表在 MySQL）', fields: [
      { key: 'db.mysqlUrl', label: 'MySQL 连接串', type: 'text', hint: 'mysql://用户:密码@127.0.0.1:3306/autotest · 留空时自动降级为本地 SQLite（data/autotest.sqlite3）' },
      { key: 'auth.inviteOnly', label: '仅邀请码注册', type: 'bool' },
      { key: 'auth.accessTtlSec', label: '登录有效期（秒）', type: 'number' },
      { key: 'auth.refreshTtlDays', label: '会话保持（天）', type: 'number' },
      { key: 'auth.jwtSecret', label: 'JWT 密钥（留空自动生成）', type: 'text' },
      { key: 'auth.bootstrapPassword', label: '首启 admin 密码（留空随机）', type: 'text' },
    ],
  },
];

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [shards, setShards] = useState<ShardStat[]>([]);
  const [dshDefault, setDshDefault] = useState<{ provider: string; model: string } | null>(null);
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
    api.dshDefaultModel().then((r) => setDshDefault(r.dshDefault)).catch(() => {});
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
          {sec.title === 'Agent 与任务' && dshDefault && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
              ⚡ DSH 当前默认模型：{dshDefault.provider}/{dshDefault.model}（默认模型留空时自动跟随）
            </div>
          )}
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
