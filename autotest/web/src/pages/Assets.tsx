import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import KnowledgePage from '../views/Knowledge';

/**
 * 资产页（R8 Phase 2a）—— 平台沉淀的可复用资产，一个页面 4 个 Tab。
 *
 * 产品动机：预设方案 / 脚本资产 / 测试资源这三项能力 R1/R2 就建好了
 * （GET /survey/presets、/env/scripts、/resources 都有），但前端一直没给入口，
 * 用户根本不知道它们存在。这里补上门，并把知识库并入同一区——
 * 四者的共性都是"平台攒下来的、可复用的东西"。
 */
type Tab = 'knowledge' | 'presets' | 'scripts' | 'resources';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'knowledge', label: '知识', icon: '📖' },
  { key: 'presets', label: '预设方案', icon: '📋' },
  { key: 'scripts', label: '脚本资产', icon: '🧰' },
  { key: 'resources', label: '测试资源', icon: '📦' },
];

export default function AssetsPage() {
  const [tab, setTab] = useState<Tab>('knowledge');

  return (
    <>
      <div className="page-title">资产</div>
      <div className="page-desc">
        平台沉淀的可复用资产 —— 知识条目、按库类别的预设方案、环境脚本资产、测试资源。
        这四类是"用得越久越值钱"的部分：每次人工确认的结论都会沉淀到这里。
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

      {tab === 'knowledge' && <KnowledgePage />}
      {tab === 'presets' && <PresetsTab />}
      {tab === 'scripts' && <ScriptsTab />}
      {tab === 'resources' && <ResourcesTab />}
    </>
  );
}

/* ---------------- 预设方案 ---------------- */

function PresetsTab() {
  const [data, setData] = useState<{ kinds: string[]; root: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.surveyPresets().then(setData).catch((e) => setError(String((e as Error).message)));
  }, []);

  if (error) return <div className="error">⚠️ {error}</div>;
  if (!data) return <div className="loading">加载中…</div>;

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        预设方案 = 按库类别准备好的「开箱可用」环境方案（工具链 + 步骤序列 + 判据配方 + 资源清单）。
        新库按类别套预设即可得到完整环境画像，不必从零分析——这是全量规模化的关键。
      </div>
      <div className="grid-3">
        {data.kinds.map((k) => (
          <div key={k} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>{k}</b>
              <span className="tag blue">预设</span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              含工具链要求、步骤序列（ohpm_install → build_manifest → build_hap → hdc_install）、
              判据配方与资源清单。
            </div>
            <div className="muted mono" style={{ fontSize: 10.5, marginTop: 6 }}>{data.root}/{k}/</div>
          </div>
        ))}
        {data.kinds.length === 0 && (
          <div className="empty"><div className="empty-t">没有预设方案</div></div>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
        预设文件位于 <span className="mono">{data.root}</span>，每类一个目录，可按需扩充。
        类别命中即生成环境画像；没有预设的类别走 AI 增量分析（L2）。
      </div>
    </>
  );
}

/* ---------------- 脚本资产 ---------------- */

function ScriptsTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.envScripts>> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.envScripts().then(setData).catch((e) => setError(String((e as Error).message)));
  }, []);

  if (error) return <div className="error">⚠️ {error}</div>;
  if (!data) return <div className="loading">加载中…</div>;

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        脚本资产 = 「从克隆代码到装上包」的每一步。平台只认**契约**不认实现——
        契约七项（输入/输出/适用条件/失败分类/幂等/超时/审批）是单一事实源，
        实现（.ps1/.sh 成对）可按需替换。
      </div>

      {data.drift.length > 0 && (
        <div className="error" style={{ marginBottom: 10 }}>
          ⚠️ {data.drift.length} 个脚本契约与记录不一致（升级后需重跑锁）：{data.drift.map((d) => d.id).join(', ')}
        </div>
      )}

      <table>
        <thead>
          <tr><th>脚本</th><th>用途</th><th>审批</th><th>超时</th><th>幂等</th><th>失败分类</th></tr>
        </thead>
        <tbody>
          {data.items.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.id}{s.builtin ? '' : ' · 自定义'}</td>
              <td>{s.summary}</td>
              <td><span className={`tag ${s.approval === 'none' ? 'gray' : 'amber'}`}>{s.approval}</span></td>
              <td className="muted">{Math.round(s.timeoutSec / 60)}min</td>
              <td>{s.idempotent ? <span className="tag green">是</span> : <span className="tag amber">否</span>}</td>
              <td className="muted" style={{ fontSize: 11 }}>
                {s.failureTaxonomy.map((k) => data.failureLabels[k] ?? k).join(' / ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
        失败分类共 {Object.keys(data.failureLabels).length} 类——归类结果决定"人该做什么"，
        也是知识库按类别召回经验的依据。退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消。
      </div>
    </>
  );
}

/* ---------------- 测试资源 ---------------- */

function ResourcesTab() {
  const [data, setData] = useState<{ items: Array<{
    resourceId: string; kind: string; origin: string; scopeKind: string; scopeKey: string;
    generator: string; filePath: string; sha256: string; size: number;
    validated: boolean; problems: string[]; intent: string; reuseCount: number; expiresAt: string | null;
  }> } | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.resources().then(setData).catch((e) => setError(String((e as Error).message)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const synthesize = async (kind: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.resourcesSynthesize(kind);
      setMsg(`已登记 ${r.registered} 个合成资源${r.problems ? `（${r.problems} 个为故意畸形，已标记）` : ''}`);
      load();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const items = data?.items ?? [];

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        测试资源 = 用例跑起来需要的输入（动画 json、CA 证书、mock server fixture、数据库 fixture…）。
        三类来源全部登记：**仓库检出 / 上游 canonical / 程序合成**，带 sha256 与 schema 校验——
        绝不现场编，否则结果不可复现。
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {['animation', 'storage', 'network', 'codec', 'ui_component'].map((k) => (
          <button key={k} className="btn sm" disabled={busy} onClick={() => void synthesize(k)}>
            合成 {k} 资源
          </button>
        ))}
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-ic">📦</div>
          <div className="empty-t">还没有登记的资源</div>
          <div className="empty-d">点上方按钮合成一类资源，或在库工作区跑采集发现仓库自带资源。</div>
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>资源</th><th>类型</th><th>来源</th><th>大小</th><th>校验</th><th>复用</th><th>用途</th></tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.resourceId}>
                <td className="mono">{r.resourceId}</td>
                <td><span className="tag gray">{r.kind}</span></td>
                <td><span className="tag outline">{r.origin}</span></td>
                <td className="muted">{(r.size / 1024).toFixed(1)}KB</td>
                <td>
                  {r.validated
                    ? <span className="tag green">通过</span>
                    : <span className="tag amber" title={(r.problems ?? []).join('；')}>有问题</span>}
                </td>
                <td className="muted">{r.reuseCount}</td>
                <td className="muted" style={{ fontSize: 11 }}>{r.intent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
