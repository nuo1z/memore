import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.memore.app",
  appName: "Memore",
  webDir: "dist",
  server: {
    // Android 端通过本地 Go 服务（127.0.0.1:8081）提供页面与 API。
    // cleartext=true 仅用于 localhost 本地通信，不走公网。
    url: "http://127.0.0.1:8081",
    cleartext: true,
    androidScheme: "http",
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
};

export default config;
