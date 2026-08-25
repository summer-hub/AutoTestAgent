/** 清理历史模拟设备残留（按型号签名精确匹配，真实设备不受影响）。 */
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
/** 启动入口：立即扫一次（含假设备清理）+ 周期 tick。 */
export declare function startDeviceAutoScan(): void;
