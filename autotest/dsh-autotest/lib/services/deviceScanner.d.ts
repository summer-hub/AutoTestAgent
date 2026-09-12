/** 清理历史模拟设备残留（serial 生成格式 + 型号双重匹配，真实设备不受影响）。 */
export declare function purgeSimulatedDevices(): Promise<number>;
/**
 * 扫描一次真机并更新数据库状态。
 * 返回 detected = 本次 hdc 发现的设备数（-1 表示已有扫描在进行）。
 */
export declare function autoScanDevices(): Promise<{
    ok: boolean;
    detected: number;
    reason?: string;
}>;
/**
 * 启动入口：立即扫一次（含假设备清理）+ 周期 tick。
 * 返回 disposer —— 插件卸载/重载时必须清掉这个 interval，否则每重载一次就多一个后台轮询。
 */
export declare function startDeviceAutoScan(): () => void;
