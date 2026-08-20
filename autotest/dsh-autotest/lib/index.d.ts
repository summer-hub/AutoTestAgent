import { Context } from '@deepseek-ai/cordis';
import type WebServer from '@deepseek-ai/dsh-host-webserver';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServer;
    }
}
export declare const name = "dsh-autotest";
export declare const inject: readonly ["webServer", "llm"];
export declare function apply(ctx: Context): void;
