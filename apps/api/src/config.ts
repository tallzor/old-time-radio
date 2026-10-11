import { resolve } from "node:path";

export type AppConfig = {
  dataDir: string;
  port: number;
  webOrigin: string;
  adminBootstrapToken?: string;
  wechatEnabled: boolean;
  wechatSdkEnabled: boolean;
  environment: "development" | "test" | "production";
};

function bool(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const environment = (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development") as AppConfig["environment"];
  return {
    dataDir: resolve(overrides.dataDir ?? process.env.APP_DATA_DIR ?? ".data"),
    port: Number(overrides.port ?? process.env.PORT ?? 3001),
    webOrigin: overrides.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:5173",
    adminBootstrapToken: overrides.adminBootstrapToken ?? process.env.ADMIN_BOOTSTRAP_TOKEN,
    wechatEnabled: overrides.wechatEnabled ?? bool(process.env.WECHAT_ENABLED),
    wechatSdkEnabled: overrides.wechatSdkEnabled ?? bool(process.env.WECHAT_SDK_ENABLED),
    environment: overrides.environment ?? environment
  };
}
