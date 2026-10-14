// survey 统一出口：全量库 L0 画像采集流水线。
//
// 分层（与 envkit 同构，遵守 rules/arch-layering：db → services → api）：
//   facts.ts    纯函数：库类别判定、事实构建、README 情报抽取、资源候选发现
//   scan.ts     IO：把仓库读成 RawRepoScan（有界、只读、跳过构建产物）
//   presets.ts  数据：按类别读预设（assets/presets/<kind>/preset.json）
//   pipeline.ts 编排：批次/单库采集、受控并发、断点续跑、失败隔离、L1 画像生成
//
// api 层只 import 本文件，不要直接钻子模块。
export { LIBRARY_KINDS, KIND_LABEL, classifyKind, buildLibraryFacts, extractReadmeIntel, presetKindFor, } from './facts.js';
export { scanRepo } from './scan.js';
export { presetsRoot, availablePresetKinds, loadPreset, presetStepsToProfileSteps, presetComponentsFor, } from './presets.js';
export { runSurveyBatch, surveyLibrary, surveyStats, saveFactsForTest, createProfileFromPreset, } from './pipeline.js';
