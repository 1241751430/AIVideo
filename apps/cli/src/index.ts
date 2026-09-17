#!/usr/bin/env node
/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description node 可执行入口：启动 cli.ts 的 main，并把未捕获错误输出为退出码
 * @see https://github.com/1241751430/AIVideo.git
 */
import { main } from "./cli.js";

void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
