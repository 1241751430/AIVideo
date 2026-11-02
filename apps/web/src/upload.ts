/**
 * @file upload.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description 参考图批量上传的执行器：小并发池（3 路）把 20 张图的往返从串行压成三路并行；
 * 每张各自重试瞬时失败（网络断开/5xx），4xx 这类确定性失败立刻中止而不是白重试；
 * 字节级进度按「全批已传字节 / 全批总字节」汇总，进度条不会因为某张重试而倒着跳；
 * 支持 skipIndexes 续传——会话里已经落定的张直接计入完成，断线重来不必从第一张重爬。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { ApiError, api } from "./api";

/** 同时在途的上传路数：浏览器对同源并发有上限，3 路既吃满带宽又不至于把弱网下的小文件饿死。 */
const CONCURRENT_UPLOADS = 3;

/** 单张最多尝试次数（含首次）：瞬时抖动两次基本能恢复，再多就是对方真的坏了。 */
const MAX_ATTEMPTS = 3;

/** 重试退避基数（ms）：第 n 次重试等 n × 400ms，避免网络刚断就一起重连。 */
const RETRY_BACKOFF_MS = 400;

/** 批量上传的进度快照。 */
export interface UploadBatchProgress {
  /** 已落定的张数（服务端确认收下或续传时判定已在盘）。 */
  done: number;
  total: number;
  /** 全批已上传字节（含正在传的那几张的实时字节）。 */
  loadedBytes: number;
  totalBytes: number;
}

/** 批量上传的入参。 */
export interface UploadBatchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadBatchProgress) => void;
  /** 续传时跳过的序号（会话里已经落定的张）。 */
  skipIndexes?: ReadonlySet<number>;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断错误是否值得重试：网络层失败（status 0）与 5xx 可重试，其余 4xx 是确定性拒绝（超限/格式/序号越界），重试只会得到同一个答案。
 * @param error 捕获到的错误
 * @returns 是否应当重试
 */
function isRetryable(error: unknown): boolean {
  // 取消不是失败：交给上层按 AbortError 处理，绝不能在这里又排队重试一遍。
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }
  if (error instanceof ApiError) {
    return error.status === 0 || error.status >= 500;
  }
  return false;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：可取消的延时（重试退避用）；取消时立刻抛出 AbortError，不会让用户等完退避才看到停止。
 * @param ms 等待毫秒数
 * @param signal 取消信号
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("上传已取消", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException("上传已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一批参考图按小并发池传进上传会话；任一张重试耗尽即整体失败（异常携带该张的名字，便于用户定位是哪一张）。
 * 失败做的是「停止后续」而不是「回滚已传」：会话本身由调用方决定保留还是销毁，保留即可用 skipIndexes 续传。
 * @param uploadId 上传会话 id
 * @param picks 待传图片（顺序即服务端序号）
 * @param options 取消信号、进度回调与续传跳过集合
 */
export async function uploadRefImages(
  uploadId: string,
  picks: Array<{ name: string; file: File }>,
  options: UploadBatchOptions = {}
): Promise<void> {
  const total = picks.length;
  const totalBytes = picks.reduce((sum, pick) => sum + pick.file.size, 0);
  // 每张各自记已传字节：总进度是各张之和，某张重试清零时整条进度只回退一张的量。
  const loaded = new Array<number>(total).fill(0);
  let doneCount = 0;
  const queue: number[] = [];
  picks.forEach((pick, index) => {
    if (options.skipIndexes?.has(index)) {
      // 续传：会话里已在盘的那几张直接算完成，进度条从断点起步。
      loaded[index] = pick.file.size;
      doneCount += 1;
    } else {
      queue.push(index);
    }
  });

  const report = (): void => {
    options.onProgress?.({
      done: doneCount,
      total,
      loadedBytes: loaded.reduce((sum, value) => sum + value, 0),
      totalBytes
    });
  };
  report();

  // 内部取消柄：调用方的 signal 只表达「用户取消」，而这里还要表达「有一张已经彻底失败，别再往下传了」。
  // 两者合流后，失败时另外几路的在途请求会立刻中止——否则 Promise.all 已经 reject 了，
  // 后台却还有两路在往会话里写字节，既白耗流量，也让下一次「继续上传」的断点变得难以解释。
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  const signal = controller.signal;

  const runOne = async (index: number): Promise<void> => {
    const pick = picks[index];
    if (!pick) {
      return;
    }
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) {
        throw new DOMException("上传已取消", "AbortError");
      }
      try {
        await api.uploadImage(uploadId, index, pick.file, {
          signal,
          onProgress: ({ loaded: current }) => {
            loaded[index] = current;
            report();
          }
        });
        loaded[index] = pick.file.size;
        doneCount += 1;
        report();
        return;
      } catch (error) {
        loaded[index] = 0;
        report();
        if (!isRetryable(error)) {
          throw error;
        }
        if (attempt >= MAX_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`「${pick.name}」上传失败：${reason}`);
        }
        await sleep(RETRY_BACKOFF_MS * attempt, signal);
      }
    }
  };

  // 小并发池：固定 CONCURRENT_UPLOADS 个 worker 从共享游标取号。
  // 错误处理刻意不用 Promise.all 的「首个 reject 即胜」：一张 4xx 失败会 abort 其余几路，
  // 那些在途请求随即以 AbortError 退出，很可能抢在真实错误前面把 Promise.all 打穿，
  // 用户就会看到「上传已取消」而不是「第 3 张超过 10MB」。所以这里先把错误收进 failure，等所有 worker 收工再抛。
  let failure: unknown = null;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure) {
        return;
      }
      const next = cursor;
      cursor += 1;
      const index = queue[next];
      if (index === undefined) {
        return;
      }
      try {
        await runOne(index);
      } catch (error) {
        failure ??= error;
        // 真实失败要顺带停掉在途的那几路；用户取消则本来就该停，不必再 abort 一次。
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          controller.abort();
        }
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_UPLOADS, queue.length) }, () => worker()));
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }
  if (failure) {
    throw failure;
  }
}