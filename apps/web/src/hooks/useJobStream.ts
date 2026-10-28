/**
 * @file useJobStream.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务实时状态 Hook：REST 拉取完整任务视图 + EventSource 订阅 SSE；status 事件触发重拉（保持 result 等派生字段最新），log 事件累计进日志面板。浏览器断线由 EventSource 携带 Last-Event-ID 自动重连重放；断线期间另有定时补拉兜底——EventSource 遇到 404/502 会永久放弃重连，没有兜底的话页面会冻在最后一帧。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import type { EventRecord, JobDto } from "@aivideo/shared";
import { api } from "../api";

/** 断线后的补拉节拍（ms）：宁可多问几次，也不能让用户盯着一动不动的进度条。 */
const OFFLINE_POLL_MS = 3000;

/** useJobStream 返回值。 */
export interface JobStream {
  job: JobDto | null;
  events: EventRecord[];
  /** SSE 是否处于连接状态（仅展示用）。 */
  connected: boolean;
  error: string | null;
  /** 手动重拉任务视图。 */
  refresh: () => void;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：订阅指定任务的事件流并维护最新任务视图；jobId 变化时自动重连，卸载时关闭。
 */
export function useJobStream(jobId: string | null): JobStream {
  const [job, setJob] = useState<JobDto | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    if (!jobId) {
      return;
    }
    api
      .getProject(jobId)
      .then((res) => {
        setJob(res.project);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setEvents([]);
    setError(null);
    if (!jobId) {
      return;
    }
    refresh();
    const source = new EventSource(`/api/projects/${encodeURIComponent(jobId)}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message: MessageEvent<string>) => {
      let record: EventRecord;
      try {
        record = JSON.parse(message.data) as EventRecord;
      } catch {
        return;
      }
      setEvents((prev) => (prev.some((item) => item.id === record.id) ? prev : [...prev, record].slice(-500)));
      if (record.type === "status") {
        refresh();
      }
    };
    return () => source.close();
  }, [jobId, refresh]);

  // 断线兜底：EventSource 在服务端重启、反代回 502、路由变 404 之后会永久停止重连，
  // 只有 onerror 已经把 connected 置 false 是不够的。这里在断线期间自己按节拍拉任务视图。
  const offline = jobId !== null && !connected;
  useEffect(() => {
    if (!offline) {
      return;
    }
    refresh();
    const timer = window.setInterval(refresh, OFFLINE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [offline, refresh]);

  return { job, events, connected, error, refresh };
}
