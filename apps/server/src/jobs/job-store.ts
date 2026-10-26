/**
 * @file job-store.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description job.json 的原子读写与项目扫描：tmp+rename 落盘、损坏文件隔离返回、把磁盘上的 project/* 合并成列表条目、按 id 安全删除项目目录。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPathWithin, isValidProjectId } from "@aivideo/core";
import type { Job } from "../types.js";

/** 任务状态文件（位于项目目录内）。 */
export const JOB_FILE = "job.json";

/** scanProjects 的单条结果。 */
export interface ProjectDiskEntry {
  projectId: string;
  job: Job | null;
  /** job.json 存在但无法解析（boot 时隔离，不自动跑）。 */
  corrupt: boolean;
  hasProjectDir: boolean;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼出任务在项目目录内 job.json 的绝对路径，先校验 projectId 合法且落在 projectsRoot 内。
 * @param projectsRoot 项目根目录
 * @param projectId 项目 id
 * @returns job.json 绝对路径
 */
export function jobFilePath(projectsRoot: string, projectId: string): string {
  return join(projectDirOf(projectsRoot, projectId), JOB_FILE);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：原子写入 job.json（先写 .tmp 再 rename），目录不存在时自动创建；调用方（runner）是唯一写者。
 * @param projectsRoot 项目根目录
 * @param job 任务实体
 */
export function writeJob(projectsRoot: string, job: Job): void {
  const target = jobFilePath(projectsRoot, job.projectId);
  mkdirSync(join(target, ".."), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取并解析 job.json；id 非法、文件不存在或无法解析/形状不符均返回 null（调用方结合文件存在性判定损坏）。
 * @param projectsRoot 项目根目录
 * @param projectId 项目 id
 * @returns 解析出的任务或 null
 */
export function readJob(projectsRoot: string, projectId: string): Job | null {
  try {
    // 路径构造也在 try 内：磁盘上的目录名不受本应用控制，非法 id 不该让调用方（boot/列表）崩掉。
    const target = jobFilePath(projectsRoot, projectId);
    if (!existsSync(target)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Job;
    if (!parsed || typeof parsed !== "object" || parsed.projectId !== projectId || typeof parsed.phase !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：扫描 projectsRoot 下的一级目录，返回每个项目的磁盘条目（job.json 解析结果 + 是否损坏），按 id 排序。
 * 目录名不是合法项目 id 的（例如手工建的 `my project`）直接跳过：本应用的任何路由都无法按这种 id 寻址，
 * 列出来只会给出点进去必报错的条目，而 boot 与列表接口不该被这种目录拖垮。
 * @param projectsRoot 项目根目录
 * @returns 项目磁盘条目数组
 */
export function scanProjects(projectsRoot: string): ProjectDiskEntry[] {
  if (!existsSync(projectsRoot)) {
    return [];
  }
  const entries: ProjectDiskEntry[] = [];
  for (const name of readdirSync(projectsRoot).sort()) {
    if (!isValidProjectId(name)) {
      continue;
    }
    let dirIsDirectory = false;
    try {
      dirIsDirectory = statSync(join(projectsRoot, name)).isDirectory();
    } catch {
      continue;
    }
    if (!dirIsDirectory) {
      continue;
    }
    const hasJobFile = existsSync(join(projectsRoot, name, JOB_FILE));
    const job = hasJobFile ? readJob(projectsRoot, name) : null;
    entries.push({ projectId: name, job, corrupt: hasJobFile && job === null, hasProjectDir: true });
  }
  return entries;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除整个项目目录（含 job.json 与产物），路径必须落在 projectsRoot 内。
 * @param projectsRoot 项目根目录
 * @param projectId 项目 id
 */
export function removeProject(projectsRoot: string, projectId: string): void {
  rmSync(projectDirOf(projectsRoot, projectId), { recursive: true, force: true });
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 projectId 合法并返回其项目目录绝对路径（越界抛错）。runner 与各路由共用这一个入口，避免各自裸 join。
 */
export function projectDirOf(projectsRoot: string, projectId: string): string {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid project id: ${JSON.stringify(projectId)}`);
  }
  const dir = join(projectsRoot, projectId);
  assertPathWithin(projectsRoot, dir, "Project directory");
  return dir;
}
