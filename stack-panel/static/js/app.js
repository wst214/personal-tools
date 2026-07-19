const $ = (sel) => document.querySelector(sel);

const stackList = $("#stackList");
const logBox = $("#logBox");
const taskStatus = $("#taskStatus");
const envBadge = $("#envBadge");
const rootPath = $("#rootPath");
const dockerVersion = $("#dockerVersion");
const stackCount = $("#stackCount");
const runningCount = $("#runningCount");
const stackTemplate = $("#stackTemplate");

const STATUS_LABEL = {
  idle: "空闲",
  running: "执行中…",
  done: "完成",
  error: "失败",
};

const modeMemory = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function shortImage(image) {
  if (!image) return "";
  const value = String(image);
  if (value.startsWith("sha256:")) return `${value.slice(0, 19)}…`;
  const parts = value.split("/");
  return parts[parts.length - 1];
}

function modeStorageKey(stackId) {
  return `stack-panel-build-mode:${stackId}`;
}

function getSelectedMode(stack) {
  const modes = stack.build_modes || [];
  if (!modes.length) return "";
  const remembered = modeMemory.get(stack.id) || localStorage.getItem(modeStorageKey(stack.id));
  if (remembered && modes.some((mode) => mode.id === remembered)) {
    return remembered;
  }
  const fallback = modes.find((mode) => mode.default) || modes[0];
  return fallback.id;
}

function setSelectedMode(stackId, modeId) {
  modeMemory.set(stackId, modeId);
  localStorage.setItem(modeStorageKey(stackId), modeId);
}

let pollTimer = null;
let activeTaskId = null;
let busy = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok && !data.error) {
    throw new Error(`请求失败 (${res.status})`);
  }
  return data;
}

function setBusy(next) {
  busy = next;
  document.querySelectorAll("button[data-action], button[data-quick], input[name^='build-mode-']").forEach((el) => {
    el.disabled = next;
  });
}

function renderEnv(info) {
  rootPath.textContent = info.mytools_root || "--";
  dockerVersion.textContent = info.docker_ok
    ? `Docker ${info.docker_version || "ready"} · Compose ${info.compose_ok ? "ready" : "missing"}`
    : "Docker 不可用";

  envBadge.className = "badge";
  if (info.docker_ok && info.compose_ok) {
    envBadge.classList.add("badge-ok");
    envBadge.textContent = "Docker ready";
  } else if (info.docker_ok) {
    envBadge.classList.add("badge-warn");
    envBadge.textContent = "Compose missing";
  } else {
    envBadge.classList.add("badge-error");
    envBadge.textContent = "Docker offline";
  }
}

function renderSummary(stacks) {
  stackCount.textContent = String(stacks.length);
  runningCount.textContent = String(
    stacks.reduce((sum, stack) => sum + (stack.running_count || 0), 0),
  );
}

function serviceActions(stackId, service, canPackage) {
  const actions = [];
  if (canPackage) {
    actions.push({ action: "package", label: "Maven 打包" });
  }
  actions.push(
    { action: "up", label: "构建启动", primary: true },
    { action: "build", label: "构建" },
    { action: "restart", label: "重启" },
    { action: "logs", label: "日志" },
    { action: "stop", label: "停止" },
  );
  return actions
    .map(
      (item) =>
        `<button type="button" class="btn ${item.primary ? "btn-dark" : "btn-ghost"}" data-stack="${stackId}" data-service="${service.name}" data-action="${item.action}">${item.label}</button>`,
    )
    .join("");
}

function renderServiceCard(stackId, service, packageServices = []) {
  const state = service.state || "stopped";
  const port = service.port ? `端口 ${service.port}` : "无固定端口";
  const imageName = shortImage(service.image);
  const image = imageName
    ? `<code title="${escapeAttr(service.image)}">${escapeHtml(imageName)}</code>`
    : "<code>—</code>";
  const link = service.url
    ? `<a class="service-link" href="${service.url}" target="_blank" rel="noreferrer">打开 ↗</a>`
    : "";
  const canPackage = packageServices.includes(service.name);
  return `
    <article class="service-card ${state}">
      <div class="service-top">
        <div>
          <h3>${service.label}</h3>
          <div class="service-meta">
            <span>${port}</span>
            <span>${image}</span>
            <span>${service.status || "未运行"}</span>
          </div>
        </div>
        <span class="service-state ${state}">${state === "running" ? "在线" : "离线"}</span>
      </div>
      ${link}
      <div class="service-actions">${serviceActions(stackId, service, canPackage)}</div>
    </article>
  `;
}

function selectedModeHasMaven(stack) {
  const modes = stack.build_modes || [];
  if (!modes.length) return (stack.package_services || []).length > 0;
  const selected = getSelectedMode(stack);
  const current = modes.find((mode) => mode.id === selected) || modes[0];
  return Boolean(current?.has_maven);
}

function syncPackageButtons(node, stack) {
  const showPackage =
    selectedModeHasMaven(stack) && (stack.package_services || []).length > 0;
  const packageBtn = node.querySelector("[data-package-btn]");
  if (packageBtn) {
    packageBtn.classList.toggle("hidden", !showPackage);
  }
  node.querySelectorAll('.service-actions [data-action="package"]').forEach((btn) => {
    btn.classList.toggle("hidden", !showPackage);
  });
}

function renderBuildModes(node, stack) {
  const row = node.querySelector("[data-build-modes]");
  const modes = stack.build_modes || [];
  if (!modes.length) {
    row.classList.add("hidden");
    row.innerHTML = "";
    return;
  }

  const selected = getSelectedMode(stack);
  setSelectedMode(stack.id, selected);
  const current = modes.find((mode) => mode.id === selected) || modes[0];

  row.classList.remove("hidden");
  row.innerHTML = `
    ${modes
      .map(
        (mode) => `
      <label class="${mode.id === selected ? "active" : ""}" title="${escapeAttr(mode.hint || "")}">
        <input type="radio" name="build-mode-${stack.id}" value="${escapeAttr(mode.id)}" ${mode.id === selected ? "checked" : ""} />
        ${escapeHtml(mode.label)}
      </label>
    `,
      )
      .join("")}
    <p class="build-mode-hint">${escapeHtml(current.hint || "")}</p>
  `;

  row.querySelectorAll("input[type='radio']").forEach((input) => {
    input.addEventListener("change", () => {
      setSelectedMode(stack.id, input.value);
      const next = modes.find((mode) => mode.id === input.value);
      row.querySelectorAll("label").forEach((label) => {
        label.classList.toggle("active", label.querySelector("input")?.value === input.value);
      });
      const hint = row.querySelector(".build-mode-hint");
      if (hint) hint.textContent = next?.hint || "";
      syncPackageButtons(node, stack);
    });
  });
}

function renderStacks(stacks) {
  stackList.innerHTML = "";
  stacks.forEach((stack) => {
    const node = stackTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.stackId = stack.id;
    node.querySelector(".stack-kicker").textContent = stack.project.toUpperCase();
    node.querySelector(".stack-title").textContent = stack.label;
    node.querySelector(".stack-desc").textContent = stack.description;
    node.querySelector(".stack-count").textContent = `${stack.running_count}/${stack.service_count} 服务在线`;

    node.querySelectorAll(".stack-actions [data-action]").forEach((btn) => {
      btn.dataset.stack = stack.id;
    });

    renderBuildModes(node, stack);

    const grid = node.querySelector(".service-grid");
    grid.innerHTML = (stack.services || [])
      .map((service) => renderServiceCard(stack.id, service, stack.package_services || []))
      .join("");

    syncPackageButtons(node, stack);
    stackList.appendChild(node);
  });
}

function renderTask(task) {
  taskStatus.textContent = STATUS_LABEL[task.status] || task.status;
  taskStatus.className = `status-pill ${task.status}`;
  if (task.logs?.length) {
    logBox.textContent = task.logs.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
  }
}

async function refreshStacks() {
  const data = await api("/api/stacks");
  renderSummary(data.stacks);
  renderStacks(data.stacks);
}

async function runAction(stackId, action, services = []) {
  if (busy) return;
  setBusy(true);
  taskStatus.textContent = STATUS_LABEL.running;
  taskStatus.className = "status-pill running";
  const buildMode = modeMemory.get(stackId) || localStorage.getItem(modeStorageKey(stackId)) || "";
  const modeLabel = buildMode ? ` [${buildMode}]` : "";
  logBox.textContent = `$ ${action}${modeLabel} ${services.join(" ") || "(all)"}\n`;

  try {
    const data = await api(`/api/stacks/${stackId}/action`, {
      method: "POST",
      body: JSON.stringify({ action, services, build_mode: buildMode || null }),
    });
    if (!data.ok) {
      throw new Error(data.error || "操作失败");
    }
    activeTaskId = data.task.id;
    startPolling();
  } catch (error) {
    taskStatus.textContent = STATUS_LABEL.error;
    taskStatus.className = "status-pill error";
    logBox.textContent += `\n[error] ${error.message}`;
    setBusy(false);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!activeTaskId) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    try {
      const task = await api(`/api/tasks/${activeTaskId}`);
      renderTask(task);
      if (task.status !== "running") {
        clearInterval(pollTimer);
        pollTimer = null;
        activeTaskId = null;
        setBusy(false);
        await refreshStacks();
      }
    } catch (_error) {
      clearInterval(pollTimer);
      pollTimer = null;
      activeTaskId = null;
      setBusy(false);
    }
  }, 900);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-action], button[data-quick], button[data-refresh]");
    if (!target || target.disabled) return;

    if (target.hasAttribute("data-refresh")) {
      refreshStacks().catch((error) => {
        logBox.textContent = `[error] ${error.message}`;
      });
      return;
    }

    const stackId = target.dataset.stack || target.dataset.quick;
    const action = target.dataset.action;
    const service = target.dataset.service;
    if (!stackId || !action) return;

    const services = service ? [service] : [];
    const label = service ? `${action} ${service}` : `${action} (stack)`;
    logBox.textContent = `准备执行：${label}\n`;
    runAction(stackId, action, services);
  });
}

async function boot() {
  bindEvents();
  try {
    const info = await api("/api/info");
    renderEnv(info);
    await refreshStacks();
  } catch (error) {
    envBadge.className = "badge badge-error";
    envBadge.textContent = "Panel error";
    logBox.textContent = `[error] ${error.message}`;
  }
}

boot();
