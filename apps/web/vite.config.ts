/**
 * @file vite.config.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description apps/web 构建配置：React 插件；开发端口 5173 并把 /api 代理到本机工作台服务（默认 8787），构建产物 dist 由 apps/server 优先托管。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.AIVIDEO_PROXY_TARGET ?? "http://127.0.0.1:8787",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
