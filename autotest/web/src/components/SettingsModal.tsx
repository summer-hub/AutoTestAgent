import { useCallback, useEffect, useState } from 'react';
import type { ModelConfig, ModelTestResult } from 'shared';
import { api } from '../api';

const PROVIDERS = [
  { v: 'deepseek', l: 'DeepSeek (OpenAI 兼容)' },
  { v: 'openai', l: 'OpenAI' },
  { v: 'ollama', l: 'Ollama 本地' },
  { v: 'custom', l: '自定义 OpenAI 兼容端点' },
];

interface FormState { name: string; provider: string; baseUrl: string; modelId: string; apiKey: string; }
const EMPTY: FormState = { name: '', provider: 'custom', baseUrl: '', modelId: '', apiKey: '' };

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sec, setSec] = useState('models');
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, ModelTestResult>>({});
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api.models().then(setModels).catch((e) => setMsg(String((e as Error).message)));
  }, []);

  useEffect(() => {
    if (open) { load(); setMsg(''); }
  }, [open, load]);

  const sections: Array<{ key: string; icon: string; label: string }> = [
    { key: 'general', icon: '⚙️', label: '通用' },
    { key: 'models', icon: '◈', label: '模型' },
    { key: 'agent', icon: '🤖', label: 'Agent 与任务' },
    { key: 'data', icon: '🗄️', label: '数据与缓存' },
    { key: 'device', icon: '📱', label: '设备与执行' },
    { key: 'about', icon: 'ℹ️', label: '关于' },
  ];
  const titles: Record<string, string> = {
    general: '通用', models: '模型', agent: 'Agent 与任务', data: '数据与缓存', device: '设备与执行', about: '关于',
  };

  const submitModel = async () => {
    if (!form.name || !form.baseUrl || !form.modelId) { setMsg('名称 / Base URL / 模型 ID 必填'); return; }
    try {
      await api.addModel({ ...form, provider: form.provider as ModelConfig['provider'] });
      setForm(EMPTY);
      setMsg('模型已添加');
      load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const testModel = async (m: ModelConfig) => {
    setTesting(m.id);
    setTestResults((r) => ({ ...r, [m.id]: { ok: false, latencyMs: null, message: '测试中…' } }));
    try {
      const r = await api.testModel(m.id);
      setTestResults((prev) => ({ ...prev, [m.id]: r }));
    } finally {
      setTesting(null);
    }
  };

  const setDefault = async (m: ModelConfig) => {
    try { await api.updateModel(m.id, { isDefault: true }); load(); } catch (e) { setMsg((e as Error).message); }
  };

  const remove = async (m: ModelConfig) => {
    try { await api.deleteModel(m.id); load(); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="s-overlay" style={{ display: open ? 'flex' : 'none' }}>
      <div className="s-mask" onClick={onClose} />
      <div className="s-panel">
        <nav className="s-nav">
          <div className="s-navTitle">设置</div>
          <div className="s-navList">
            {sections.map((s) => (
              <button
                key={s.key}
                className={`s-navCell ${sec === s.key ? 'active' : ''}`}
                onClick={() => setSec(s.key)}
              >
                <span className="s-navIcon">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </div>
          <div className="s-navFoot">AutoTest 平台 · v0.1.0</div>
        </nav>
        <div className="s-content">
          <div className="s-header">
            <div className="t">{titles[sec]}</div>
            <button className="x" onClick={onClose}>✕</button>
          </div>
          <div className="s-options">
            {sec === 'models' && (
              <div className="s-section">
                <div className="s-title">模型</div>
                <p className="s-intro">配置大模型服务。凭据状态点：绿 = 已配置可用，红 = 缺失。可自由添加自定义 OpenAI 兼容端点。</p>
                {msg && <p className="s-notice">{msg}</p>}
                <div className="s-rows">
                  {models.map((m) => (
                    <div key={m.id} className="s-rowCard">
                      <div className="s-rowHead">
                        <span className={`s-cred ${m.apiKey ? 'ok' : 'miss'}`} />
                        <span className="s-rowName">{m.name}</span>
                        <span className="s-rowTag">{m.provider}</span>
                        {m.isDefault && <span className="s-rowTag" style={{ borderColor: 'var(--green)', color: 'var(--green)' }}>默认</span>}
                        <span className="s-rowActions">
                          <button className="s-btn link" onClick={() => testModel(m)}>
                            {testing === m.id ? '⏳ 测试中…' : '测试连通性'}
                          </button>
                          {!m.isDefault && <button className="s-btn link" onClick={() => setDefault(m)}>设为默认</button>}
                          {!m.isDefault && <button className="s-btn link" style={{ color: 'var(--red)' }} onClick={() => remove(m)}>删除</button>}
                        </span>
                      </div>
                      <p className="s-rowDesc">
                        {m.baseUrl} · 模型 {m.modelId}
                        {testResults[m.id] && (
                          <span style={{ marginLeft: 8, color: testResults[m.id].ok ? 'var(--green)' : 'var(--red)' }}>
                            {testResults[m.id].ok ? '✓' : '✗'} {testResults[m.id].message}
                            {testResults[m.id].responsePreview ? ` · ${testResults[m.id].responsePreview}` : ''}
                          </span>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="s-editor" style={{ marginTop: 12 }}>
                  <div className="s-title" style={{ fontSize: 14 }}>＋ 添加自定义模型</div>
                  <div className="s-field">
                    <div className="fl"><div className="ft">名称</div></div>
                    <input className="input" style={{ width: 220 }} placeholder="如 本地 GLM" value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className="s-field">
                    <div className="fl"><div className="ft">服务商</div></div>
                    <select className="select" style={{ width: 220 }} value={form.provider}
                      onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                      {PROVIDERS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
                    </select>
                  </div>
                  <div className="s-field">
                    <div className="fl"><div className="ft">API Base URL</div></div>
                    <input className="input mono" style={{ flex: 1 }} placeholder="https://api.deepseek.com/v1" value={form.baseUrl}
                      onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
                  </div>
                  <div className="s-field">
                    <div className="fl"><div className="ft">模型 ID</div></div>
                    <input className="input mono" style={{ flex: 1 }} placeholder="deepseek-chat / glm-4-flash" value={form.modelId}
                      onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
                  </div>
                  <div className="s-field">
                    <div className="fl"><div className="ft">API Key</div></div>
                    <input className="input mono" style={{ flex: 1 }} type="password" placeholder="sk-…（留空则未配置）" value={form.apiKey}
                      onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button className="s-btn primary" onClick={submitModel}>保存模型</button>
                  </div>
                </div>
              </div>
            )}

            {sec === 'general' && (
              <div className="s-section">
                <div className="s-title">通用</div>
                <p className="s-intro">语言、工作区与行为偏好（配置存 settings 表，下一迭代接通）。</p>
                <div className="s-rows">
                  {[
                    ['界面语言', '平台界面与 AI 回复的语言', '简体中文'],
                    ['工作区路径', '三方库代码、用例与脚本的存放目录', 'D:\\autotest\\workspace'],
                  ].map(([t, d, v]) => (
                    <div key={t} className="s-rowCard">
                      <div className="s-field">
                        <div className="fl"><div className="ft">{t}</div><div className="fd">{d}</div></div>
                        <input className="input" style={{ width: 230 }} defaultValue={v} />
                      </div>
                    </div>
                  ))}
                  {[['通知', '执行完成 / 任务失败推送'], ['Excel 导入校验', '导入时校验列结构与用例 ID 唯一性'], ['审计日志', '记录用例变更、回滚、导入导出']].map(([t, d]) => (
                    <div key={t} className="s-rowCard">
                      <div className="s-field">
                        <div className="fl"><div className="ft">{t}</div><div className="fd">{d}</div></div>
                        <div className="switch on" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(sec === 'agent' || sec === 'data' || sec === 'device') && (
              <div className="s-section">
                <div className="s-title">{titles[sec]}</div>
                <p className="s-intro">该分区配置项将在下一迭代接入 settings 表持久化。</p>
                <div className="s-rows">
                  {(sec === 'agent' ? [
                    ['默认模型', '任务管理、用例生成等 Agent 的默认模型', 'deepseek-chat'],
                    ['推理温度', '用例生成等创意任务的默认温度', '0.3'],
                    ['最大并发任务', '同时执行的 AI 任务数', '8'],
                    ['上下文窗口上限', '单任务注入用例/代码的 token 上限', '64K'],
                  ] : sec === 'data' ? [
                    ['Redis 缓存', '用例库查询、任务状态、设备列表缓存（高并发）', '已启用'],
                    ['数据库连接池大小', '按 4 万+ 用例与并发执行设计', '50'],
                    ['用例表分表策略', '按库 ID 哈希分 16 表（MySQL 部署）', '已启用'],
                    ['执行结果归档', '历史执行结果归档至冷存储', '90 天'],
                  ] : [
                    ['设备执行引擎', '真实设备执行链路（hdc / UI 自动化，二期）', '预留'],
                    ['默认执行超时', '单用例默认超时时间', '120s'],
                    ['失败自动重试', '环境类失败自动重试次数', '2'],
                    ['执行轨迹记录', '调试会话所需的逐步执行轨迹与 AI 思考', '已启用'],
                  ]).map(([t, d, v]) => (
                    <div key={t} className="s-rowCard">
                      <div className="s-field">
                        <div className="fl"><div className="ft">{t}</div><div className="fd">{d}</div></div>
                        <span className="s-rowTag">{v}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sec === 'about' && (
              <div className="s-section">
                <div className="s-title">关于</div>
                <p className="s-intro">AutoTest 平台 — 鸿蒙三方库自动化测试平台。</p>
                <div className="s-rows">
                  <div className="s-rowCard">
                    <div className="s-rowHead">
                      <span className="s-rowName">AutoTest 平台</span>
                      <span className="s-rowTag">v0.1.0</span>
                    </div>
                    <p className="s-rowDesc">
                      架构：围绕 DeepSeek Harness 架构理念二次开发 · 独立 Web 应用
                      <br />功能：AI 用例生成与版本化维护 · 执行计划 · 数据分析 · 多粒度归因 · 调试会话 · 设备管理
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
