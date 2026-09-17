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
 */
export class JobEventLog {
  private readonly filePath: string;

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
    const lines = this.readLines();
    const last = lines.length > 0 ? this.parseLine(lines[lines.length - 1] ?? "") : null;
    const id = last ? last.id + 1 : lines.length + 1;
    const record: EventRecord = { id, at: new Date().toISOString(), type, data };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    if (lines.length + 1 > MAX_EVENT_LINES) {
      const kept = lines.slice(-(MAX_EVENT_LINES - 1));
      writeFileSync(this.filePath, `${kept.concat(JSON.stringify(record)).join("\n")}\n`, "utf8");
    }
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
