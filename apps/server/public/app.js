/**
 * @file app.js
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 镜头墙工作台前端逻辑：项目列表、创建任务、SSE 日志流与状态轨道、取消/删除、成片预览下载。无构建步骤，直接由浏览器加载。
 * @see https://github.com/1241751430/AIVideo.git
 */
(() => {
  "use strict";

  /** 阶段顺序（与后端 StageKind 对齐）。 */
  const STAGES = ["script", "assets", "audio", "render"];
  /** 阶段中文名。 */
  const STAGE_LABELS = { script: "脚本与分镜", assets: "场景素材", audio: "旁白配音", render: "渲染成片" };
  /** 检查点中文名。 */
  const CHECKPOINT_LABELS = {
    script: "脚本已生成，请检查后继续",
    cost: "接下来的素材生成会调用远端计费模型，请确认",
    shots: "场景素材已就绪，请逐镜检查",
    audio: "旁白已合成，请试听后继续",
    final: "成片已渲染，请验收"
  };
  /** 队列阶段中文名。 */
  const PHASE_LABELS = {
    queued: "排队中",
    running: "执行中",
    awaiting: "等待确认",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消"
  };

  /** 前端全局状态。 */
  const state = {
    /** @type {string|null} 当前查看的任务 id */
    currentId: null,
    /** @type {EventSource|null} 当前 SSE 连接 */
    source: null,
    /** @type {Array<object>} 列表缓存 */
    projects: [],
    /** @type {object|null} 当前任务 DTO */
    job: null
  };

  const $ = (id) => document.getElementById(id);

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：JSON 请求封装：非 2xx 时抛出后端 error 文案。
   */
  async function api(path, options) {
    const res = await fetch(`/api${path}`, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return body;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：初始化：拉取模板/配置下拉项、系统摘要与项目列表，绑定按钮事件。
   */
  async function init() {
    try {
      const [skills, summary] = await Promise.all([api("/skills"), api("/summary")]);
      const skillSel = $("skill");
      skillSel.innerHTML = '<option value="auto">自动推荐</option>';
      for (const item of skills.skills ?? []) {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = `${item.name}（${item.id}）`;
        skillSel.appendChild(opt);
      }
      const profileSel = $("profile");
      profileSel.innerHTML = "";
      for (const id of summary.profiles ?? []) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id === summary.activeProfile ? `${id}（当前）` : id;
        profileSel.appendChild(opt);
      }
      if (summary.defaults?.durationSeconds) {
        $("duration").value = String(summary.defaults.durationSeconds);
      }
      const remoteNote = (summary.providers?.video?.remote ? "远端计费" : "本地免费") +
        (summary.providers?.image?.remote ? " / 图片远端计费" : "");
      $("system-line").textContent = `配置：${summary.activeProfile ?? "default"} · ${remoteNote || "全本地"}`;
    } catch (error) {
      $("system-line").textContent = `系统信息加载失败：${error.message}`;
    }
    $("btn-new").addEventListener("click", showCreate);
    $("btn-submit").addEventListener("click", submitCreate);
    $("btn-cancel").addEventListener("click", () => action("cancel"));
    $("btn-review-approve")?.addEventListener("click", () => review("approve"));
    $("btn-redo-stage")?.addEventListener("click", () => review("redo-stage", state.job?.stage ?? state.job?.resumeStage ?? "script"));
    $("btn-review-cancel")?.addEventListener("click", () => review("cancel"));
    $("btn-refresh").addEventListener("click", () => {
      if (state.currentId) {
        openTask(state.currentId);
      }
      loadProjects();
    });
    $("btn-delete").addEventListener("click", deleteCurrent);
    await loadProjects();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：拉取并渲染左侧项目列表（任务 + 旧目录 + 损坏项）。
   */
  async function loadProjects() {
    let items = [];
    try {
      const body = await api("/projects");
      items = body.projects ?? [];
    } catch (error) {
      console.error(error);
    }
    state.projects = items;
    const list = $("project-list");
    list.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      if (item.projectId === state.currentId) {
        li.classList.add("active");
      }
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.kind === "corrupt" ? `${item.projectId}（损坏）` : item.job ? jobTitle(item.job) : item.title ?? item.projectId;
      const dot = document.createElement("span");
      dot.className = `dot ${item.kind === "corrupt" ? "corrupt" : item.kind === "project" ? "project" : item.job.phase}`;
      li.appendChild(name);
      li.appendChild(dot);
      li.addEventListener("click", () => {
        if (item.kind === "job" && item.job) {
          openTask(item.job.id);
        } else {
          openProject(item.projectId);
        }
      });
      list.appendChild(li);
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：任务的展示标题（theme → content 前 20 字 → projectId）。
   */
  function jobTitle(job) {
    const text = job.request.theme || (job.request.content ? `${job.request.content.slice(0, 20)}…` : "");
    return text || job.projectId;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：切换到创建视图。
   */
  function showCreate() {
    closeStream();
    state.currentId = null;
    $("view-create").hidden = false;
    $("view-task").hidden = true;
    $("create-error").hidden = true;
    loadProjects();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：提交创建：POST /api/projects 后进入任务视图。
   */
  async function submitCreate() {
    const err = $("create-error");
    err.hidden = true;
    const payload = {
      briefText: $("brief").value,
      mode: $("exec-mode").value,
      generationMode: $("generation-mode").value,
      skill: $("skill").value
    };
    const duration = Number.parseInt($("duration").value, 10);
    if (Number.isFinite(duration) && duration > 0) {
      payload.durationSeconds = duration;
    }
    const profile = $("profile").value;
    if (profile) {
      payload.providerProfile = profile;
    }
    $("btn-submit").disabled = true;
    try {
      const body = await api("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      openTask(body.job.id);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    } finally {
      $("btn-submit").disabled = false;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：打开任务视图：拉 DTO、渲染状态、订阅 SSE。
   */
  async function openTask(jobId) {
    closeStream();
    state.currentId = jobId;
    $("view-create").hidden = true;
    $("view-task").hidden = false;
    $("log").textContent = "";
    $("deliver").hidden = true;
    let body;
    try {
      body = await api(`/projects/${encodeURIComponent(jobId)}`);
    } catch (error) {
      $("task-title").textContent = `任务加载失败：${error.message}`;
      return;
    }
    state.job = body.project;
    renderTask();
    connectStream(jobId);
    loadProjects();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：打开无任务的历史项目目录（仅展示成片与删除入口）。
   */
  async function openProject(projectId) {
    closeStream();
    state.currentId = projectId;
    $("view-create").hidden = true;
    $("view-task").hidden = false;
    $("log").textContent = "（历史项目目录，无运行记录）";
    state.job = { id: projectId, projectId, phase: "done", execMode: "auto", request: {} };
    $("task-title").textContent = projectId;
    renderTask();
    try {
      const body = await api(`/projects/${encodeURIComponent(projectId)}/artifacts`);
      if (body.videoReady) {
        showDeliver(projectId);
      } else {
        $("deliver").hidden = true;
      }
    } catch {
      $("deliver").hidden = true;
    }
    loadProjects();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：按 DTO 渲染：标题、徽标、阶段轨道、检查点提示与按钮可用态。
   */
  function renderTask() {
    const job = state.job;
    if (!job) {
      return;
    }
    $("task-title").textContent = jobTitle(job);
    const phaseBadge = $("task-phase");
    phaseBadge.textContent = PHASE_LABELS[job.phase] ?? job.phase;
    phaseBadge.dataset.phase = job.phase;
    $("task-mode").textContent = job.execMode === "guided" ? "分步确认" : "全自动";
    const queueBadge = $("task-queue");
    if (job.queuePosition && job.queuePosition > 1) {
      queueBadge.textContent = `排队第 ${job.queuePosition} 位`;
      queueBadge.hidden = false;
    } else {
      queueBadge.hidden = true;
    }
    const activeStage = job.stage ?? job.resumeStage;
    const order = activeStage ? STAGES.indexOf(activeStage) : job.phase === "done" ? STAGES.length : -1;
    for (const li of $("stepper").querySelectorAll("li")) {
      const idx = STAGES.indexOf(li.dataset.stage);
      li.classList.toggle("done-stage", job.phase === "done" || (order > idx && idx >= 0));
      li.classList.toggle("active", job.phase === "running" && li.dataset.stage === activeStage);
    }
    const hint = $("checkpoint-hint");
    const approveBtn = $("btn-review-approve");
    const redoBtn = $("btn-redo-stage");
    const reviewCancelBtn = $("btn-review-cancel");
    if (job.phase === "awaiting" && job.checkpoint) {
      hint.textContent = `⏸ ${CHECKPOINT_LABELS[job.checkpoint] ?? job.checkpoint}`;
      hint.hidden = false;
      if (approveBtn) { approveBtn.hidden = false; }
      if (redoBtn) { redoBtn.hidden = job.checkpoint === "final"; }
      if (reviewCancelBtn) { reviewCancelBtn.hidden = false; }
    } else {
      hint.hidden = true;
      if (approveBtn) { approveBtn.hidden = true; }
      if (redoBtn) { redoBtn.hidden = true; }
      if (reviewCancelBtn) { reviewCancelBtn.hidden = true; }
    }
    $("btn-cancel").disabled = !["queued", "running", "awaiting"].includes(job.phase);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：订阅 SSE：status 更新徽标与轨道、log 追加行、done/awaiting 时刷新增片区。
   */
  function connectStream(jobId) {
    const source = new EventSource(`/api/projects/${encodeURIComponent(jobId)}/events`);
    state.source = source;
    source.addEventListener("message", (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      appendLog(event);
      if (event.type === "status") {
        const merged = state.job ?? {};
        state.job = {
          ...merged,
          phase: event.data.phase ?? merged.phase,
          stage: event.data.stage,
          checkpoint: event.data.checkpoint,
          error: event.data.error
        };
        renderTask();
        if (state.job.phase === "done") {
          refreshArtifacts(jobId);
        }
        loadProjects();
      }
    });
    source.onerror = () => {
      // EventSource 会自动重连并携带 Last-Event-ID 重放；连接耗尽时静默降级为手动刷新。
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：关闭 SSE 连接。
   */
  function closeStream() {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：追加一行日志并自动滚到底。
   */
  function appendLog(event) {
    if (event.type !== "log") {
      return;
    }
    const pre = $("log");
    const time = (event.at ?? "").slice(11, 19);
    pre.textContent += `${time} ${event.data.message ?? ""}\n`;
    pre.scrollTop = pre.scrollHeight;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：拉取工件快照，videoReady 时展示成片面板。
   */
  async function refreshArtifacts(jobId) {
    try {
      const body = await api(`/projects/${encodeURIComponent(jobId)}/artifacts`);
      if (body.videoReady) {
        showDeliver(jobId);
      } else {
        $("deliver").hidden = true;
      }
    } catch {
      $("deliver").hidden = true;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：显示成片区（播放器 + 下载链接指向 /api/projects/:id/video）。
   */
  function showDeliver(projectId) {
    const url = `/api/projects/${encodeURIComponent(projectId)}/video`;
    const player = $("player");
    player.src = url;
    $("download").href = url;
    $("video-path").textContent = `project/${projectId}/`;
    $("deliver").hidden = false;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：取消当前任务。
   */
  async function action(name) {
    if (!state.currentId) {
      return;
    }
    try {
      await api(`/projects/${encodeURIComponent(state.currentId)}/${name}`, { method: "POST" });
      openTask(state.currentId);
    } catch (error) {
      alert(error.message);
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：提交检查点决策（approve / redo-stage / cancel）。
   */
  async function review(decision, stage) {
    if (!state.currentId) {
      return;
    }
    try {
      await api(`/projects/${encodeURIComponent(state.currentId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, stage })
      });
      openTask(state.currentId);
    } catch (error) {
      alert(error.message);
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：删除当前任务/项目（含磁盘目录），二次确认后执行。
   */
  async function deleteCurrent() {
    const id = state.currentId;
    if (!id) {
      return;
    }
    if (!window.confirm(`确认删除 ${id} 及其全部产物目录？此操作不可恢复。`)) {
      return;
    }
    try {
      await api(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      alert(error.message);
      return;
    }
    showCreate();
  }

  init().catch((error) => {
    $("system-line").textContent = `初始化失败：${error.message}`;
  });
})();
