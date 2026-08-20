export default function PlaceholderPage({ page, title }: { page: string; title: string }) {
  const plan: Record<string, string> = {
    tasks: '对话输入 + 预置卡片（拉取/更新代码、编写/更新用例、转自动化脚本）→ 后端 tasks 表 + AI 任务编排（下一迭代）',
    plans: '立即 / 定时 / 单独 / 批量 / 全量执行 → 后端 plans / executions 表 + 调度器（下一迭代）',
    analysis: '三方库 PR 更新分析 · 用例更新分析（版本递增统计）→ analyses 表 + AI 分析（下一迭代）',
    attribution: '单用例 → 单库 → 多库三粒度归因 → analyses 表 + AI 归因（下一迭代）',
    debug: '执行轨迹 + AI 思考过程 + 追问（依赖 executions 表与设备执行链路）',
    devices: '设备管理（devices 表已就绪，识别/历史设备 UI 下一迭代）',
    prompts: 'Prompt 模板管理（prompts 表已就绪，CRUD UI 下一迭代）',
  };
  return (
    <>
      <div className="page-title">{title}</div>
      <div className="page-desc">{plan[page] ?? '开发中'}</div>
      <div className="card">
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text3)' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🚧</div>
          <div style={{ fontSize: 13.5 }}>「{title}」模块开发中</div>
          <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.8 }}>
            按里程碑推进：M1 数据库 ✅ → M2 用例/库 API ✅ → M3 前端框架 + 首页 + 用例库 ✅
            <br />下一步：任务管理 / 执行计划 / AI 集成
          </div>
        </div>
      </div>
    </>
  );
}
