/**
 * @file config.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务的运行配置：监听地址（默认仅 127.0.0.1，容器内用 AIVIDEO_SERVER_HOST=0.0.0.0 覆盖）、端口（默认 8787）与可选的过期项目保留天数。
 * @see https://github.com/1241751430/AIVideo.git
 */

/** 服务监听配置。 */
export interface ServerConfig {
  host: string;
  port: number;
  /** 过期项目保留天数；不填（或非法）表示不自动清理。 */
  retentionDays?: number;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：从环境变量读取服务监听配置，HOST 默认 127.0.0.1、PORT 默认 8787（非法端口回退默认值）。
 * 保留期是可选能力：AIVIDEO_RETENTION_DAYS 不填或不是正整数时完全不开启自动清理，避免默认删掉用户数据。
 * @param env 环境变量表（默认 process.env）
 * @returns 服务监听 host/port，以及（开启时）retentionDays
 */
export function serverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env.AIVIDEO_SERVER_PORT ?? "", 10);
  // 保留期用 Number 而非 parseInt：「7.5 天」不是能表达的策略，四舍五入成 7 天反而会静默删掉本不该删的数据。
  const retentionDays = Number(env.AIVIDEO_RETENTION_DAYS ?? "");
  const config: ServerConfig = {
    host: env.AIVIDEO_SERVER_HOST?.trim() || "127.0.0.1",
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 8787
  };
  // 只在真正开启时才写出这个键：默认配置保持「没有清理功能」的原状，调用方一个 truthy 判断即可。
  if (Number.isInteger(retentionDays) && retentionDays > 0) {
    config.retentionDays = retentionDays;
  }
  return config;
}
