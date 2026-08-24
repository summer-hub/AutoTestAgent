import type { ExploredPage } from './uiExplorer.js';
/** 生成单个测试套件 Python 脚本。 */
export declare function generateHypiumScript(lib: {
    name: string;
    packageName: string;
}, pages: ExploredPage[]): string;
export interface HypiumProject {
    dir: string;
    suite: string;
    scriptFile: string;
}
/** 落盘完整 Hypium 工程到 workspace/hypium/<lib>/。 */
export declare function writeHypiumProject(lib: {
    name: string;
    packageName: string;
}, pages: ExploredPage[], serial: string): HypiumProject;
