/**
 * @file system.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 系统信息路由：/api/healthz 健康检查、/api/skills 内置模板列表、/api/summary 当前 profile 与提供者的远端/本地计费属性。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { Hono } from "hono";
import { BUILTIN_SKILLS, resolveProfileId, validateConfig } from "@aivideo/core";
import type { ServerDeps } from "../app.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建系统信息路由（healthz/skills/summary）。
 * @param deps 服务依赖
 * @returns 挂载于 /api 的 Hono 子应用
 */
export function systemRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.get("/healthz", (c) =>
    c.json({
      ok: true,
      warnings: validateConfig(deps.config)
    })
  );

  router.get("/skills", (c) =>
    c.json({
      skills: BUILTIN_SKILLS.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        suitableFor: skill.suitableFor,
        tone: skill.tone
      }))
    })
  );

  router.get("/summary", (c) => {
    const { config, providers } = deps;
    const entry = (provider: { id: string; isRemote: boolean } | undefined) =>
      provider ? { id: provider.id, remote: provider.isRemote } : null;
    return c.json({
      activeProfile: resolveProfileId(config),
      profiles: Object.keys(config.profiles),
      defaults: config.defaults,
      providers: {
        text: entry(providers.text),
        image: entry(providers.image),
        video: entry(providers.video),
        speech: entry(providers.speech)
      },
      render: {
        gpu: config.defaults.gpu === true
      }
    });
  });

  return router;
}
