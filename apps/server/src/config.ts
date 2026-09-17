/**
 * @file config.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务的运行配置：监听地址（默认仅 127.0.0.1，容器内用 AIVIDEO_SERVER_HOST=0.0.0.0 覆盖）与端口（默认 8787）。
 * @see https://github.com/1241751430/AIVideo.git
 */

/** 服务监听配置。 */
export interface ServerConfig {
  host: string;
  port: number;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：从环境变量读取服务监听配置，HOST 默认 127.0.0.1、PORT 默认 8787（非法端口回退默认值）。
 * @param env 环境变量表（默认 process.env）
 * @returns 服务监听 host/port
 */
export function serverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env.AIVIDEO_SERVER_PORT ?? "", 10);
  return {
    host: env.AIVIDEO_SERVER_HOST?.trim() || "127.0.0.1",
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 8787
  };
}
