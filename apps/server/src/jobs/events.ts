/**
 * @file events.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务事件流：events.jsonl 追加写与 1000 行截断、按 Last-Event-ID 重放、进程内事件总线与 SSE 帧格式化。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRecord } from "../types.js";

/** events.jsonl 文件名。 */
export const EVENTS_FILE = "events.jsonl";

/** 超过该行数时把日志截断为最后这么多行。 */
export const MAX_EVENT_LINES = 1000;

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把事件记录格式化为 SSE 帧（id + JSON data）。
 * @param event 事件记录
 * @returns 可直接写入响应流的字符串
 */
export function sseFrame(event: EventRecord): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：任务事件的持久日志：追加 events.jsonl（超 1000 行截断保留最近 1000 行）、按 after(id) 重放。
 * 追加路径带实例级缓存：任务跑起来后每个日志/状态事件都会追加一次，而事件里日志是高频的，
 * 原先每次都把整个文件读出来再逐行 JSON.parse，只为了拿到末条 id。缓存住「上次写完后文件长什么样」
 * （size + mtime + 末条 id + 最后 1000 行原文），文件没被外部改动时追加就只剩一次写入。
 * 外部改写（手改日志、别的进程写）会让 size/mtime 对不上，缓存自动失效并回落到全量读，
 * 因此「id 取末条 +1、末行损坏时用行数兜底」的语义不变。
 */
export class JobEventLog {
  private readonly filePath: string;
  private cache: {
    size: number;
    mtimeMs: number;
    lineCount: number;
    lastId: number | null;
    /** 文件末尾至多 MAX_EVENT_LINES 行原文，截断重写时直接从这里拼，不必再读盘。 */
    tail: string[];
  } | null = null;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：绑定项目目录（日志写入 <projectDir>/events.jsonl）。
   * @param projectDir 项目目录
   */
  constructor(projectDir: string) {
    this.filePath = join(projectDir, EVENTS_FILE);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：追加一条事件并返回完整记录；id 取末条 +1（文件损坏时以行数兜底）；超限后截断为最近 1000 行。
   * @param type 事件类型（status/log）
   * @param data 事件负载
   */
  append(type: EventRecord["type"], data: Record<string, unknown>): EventRecord {
    const state = this.snapshot();
    const id = state.lastId !== null ? state.lastId + 1 : state.lineCount + 1;
    const record: EventRecord = { id, at: new Date().toISOString(), type, data };
    const line = JSON.stringify(record);
    appendFileSync(this.filePath, `${line}\n`, "utf8");
    let lineCount = state.lineCount + 1;
    let tail = state.tail.concat(line);
    if (lineCount > MAX_EVENT_LINES) {
      // 超出上限：按原文重写最近 MAX_EVENT_LINES 行（含刚追加的这条）。
      tail = state.tail.slice(-(MAX_EVENT_LINES - 1)).concat(line);
      writeFileSync(this.filePath, `${tail.join("\n")}\n`, "utf8");
      lineCount = MAX_EVENT_LINES;
    }
    this.remember(lineCount, id, tail);
    return record;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：重放 id 大于 afterId 的全部事件（解析失败行跳过），供 SSE 断线续传。
   * @param afterId 客户端已收到的最后事件 id（0 表示从头）
   */
  after(afterId: number): EventRecord[] {
    return this.readLines()
      .map((line) => this.parseLine(line))
      .filter((event): event is EventRecord => Boolean(event && event.id > afterId));
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：取文件当前状态（行数、末条 id、末尾原文）：size/mtime 与缓存一致时直接复用，否则重读一次并刷新缓存。
   */
  private snapshot(): { lineCount: number; lastId: number | null; tail: string[] } {
    let stat;
    try {
      stat = statSync(this.filePath);
    } catch {
      this.cache = null;
      return { lineCount: 0, lastId: null, tail: [] };
    }
    if (this.cache && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache;
    }
    const lines = this.readLines();
    const last = lines.length > 0 ? this.parseLine(lines[lines.length - 1] ?? "") : null;
    this.cache = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount: lines.length,
      lastId: last ? last.id : null,
      tail: lines.slice(-MAX_EVENT_LINES)
    };
    return this.cache;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：写入成功后记录文件状态，供下一次追加判断缓存是否仍然有效。
   */
  private remember(lineCount: number, lastId: number, tail: string[]): void {
    try {
      const stat = statSync(this.filePath);
      this.cache = { size: stat.size, mtimeMs: stat.mtimeMs, lineCount, lastId, tail };
    } catch {
      this.cache = null;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：读取日志文件的全部非空行。
   */
  private readLines(): string[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      return readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：解析单行 JSONL，形状不符或缺 id 时返回 null。
   */
  private parseLine(line: string): EventRecord | null {
    try {
      const parsed = JSON.parse(line) as EventRecord;
      if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "number") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：进程内事件总线：按 jobId 维护监听者集合，供 SSE 连接订阅阶段内实时事件。
 */
export class EventHub {
  private readonly listeners = new Map<string, Set<(event: EventRecord) => void>>();

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：订阅某任务的新事件，返回取消订阅函数。
   * @param jobId 任务 id
   * @param listener 回调
   */
  subscribe(jobId: string, listener: (event: EventRecord) => void): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listeners.delete(jobId);
      }
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：向某任务的全部监听者广播事件（无监听者时静默）。
   * @param jobId 任务 id
   * @param event 事件记录
   */
  publish(jobId: string, event: EventRecord): void {
    for (const listener of this.listeners.get(jobId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken client stream must never take down the emitter.
      }
    }
  }
}
