const $ = (id) => document.getElementById(id);

const state = {
  capabilities: [],
  labels: {},
  /** @type {Array<{id:string,name:string,hasBizQuery?:boolean}>} */
  deviceTypes: [],
  /** @type {Set<string>} 执行页已选设备类型，默认全选 */
  selectedDeviceTypes: new Set(),
  /** @type {Array<{id:string,name:string,hasBizQuery?:boolean}>} */
  networks: [],
  /** @type {Set<string>} 执行页已选网络(lightning-strike-cmb/locator/radar)，默认全选 */
  selectedNetworks: new Set(),
  _networksReady: false,
  currentCapability: "warn-rule",
  runCapability: "warn-rule",
  editingModule: null,
  editingId: null,
  envDoc: null,
  selectedEnvId: null,
  /** @type {Record<string, any>} module::id -> 最近一次执行结果 */
  runResults: {},
  /** 当前展开详情的 key */
  expandedRunKey: "",
  /** 本轮勾选执行的 key 集合 */
  runQueueKeys: [],
  /** 前端侧互斥，避免连点 */
  runBusy: false,
};

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || res.statusText || "request failed");
  }
  return data;
}

function switchPage(page) {
  document.querySelectorAll(".page-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  document.querySelectorAll(".page-panel").forEach((panel) => {
    const on = panel.id === `page-${page}`;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
}

function selectedEnv() {
  const list = state.envDoc?.environments || [];
  return list.find((e) => e.id === state.selectedEnvId) || list[0] || null;
}

function capabilityById(id) {
  return state.capabilities.find((c) => c.id === id) || null;
}

function capabilityName(id) {
  return capabilityById(id)?.name || id;
}

function updateActiveBadge() {
  const active = state.envDoc?.active;
  const name = active?.name || "未启用";
  const info = inspectCredential(active?.credential || "");
  if (info.status === "ok" || info.status === "unknown") {
    $("activeEnvBadge").textContent = `${name} · 已登录`;
  } else if (info.status === "expired") {
    $("activeEnvBadge").textContent = `${name} · 凭证已过期`;
  } else {
    $("activeEnvBadge").textContent = name;
  }
}

function inspectCredential(cred) {
  let text = String(cred || "").trim();
  if (text.toLowerCase().startsWith("bearer ")) text = text.slice(7).trim();
  if (!text) {
    return {
      status: "missing",
      message: "未配置登录凭证，请先到「环境配置」点击「获取凭证」",
    };
  }
  const parts = text.split(".");
  if (parts.length !== 3) {
    return { status: "unknown", message: "已设置凭证" };
  }
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const jsonText = atob(payloadB64 + pad);
    const payload = JSON.parse(jsonText);
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp)) {
      return { status: "unknown", message: "已设置凭证" };
    }
    const now = Date.now() / 1000;
    if (now >= exp - 30) {
      return {
        status: "expired",
        exp,
        message: "登录凭证已过期，请先到「环境配置」点击「获取凭证」后再执行",
      };
    }
    return { status: "ok", exp, message: "凭证有效" };
  } catch {
    return { status: "unknown", message: "已设置凭证" };
  }
}

function updateCredStatus(cred) {
  const el = $("credStatus");
  const info = inspectCredential(cred);
  if (info.status === "ok") {
    el.textContent = "有效";
    el.className = "pill ok";
  } else if (info.status === "expired") {
    el.textContent = "已过期";
    el.className = "pill fail";
  } else if (info.status === "missing") {
    el.textContent = "未设置";
    el.className = "pill idle";
  } else {
    el.textContent = "已设置";
    el.className = "pill muted-pill";
  }
}

function renderEnvList() {
  const list = state.envDoc?.environments || [];
  const activeId = state.envDoc?.activeId;
  $("envList").innerHTML = list
    .map((e) => {
      const isActive = e.id === activeId;
      const isSel = e.id === state.selectedEnvId;
      const credInfo = inspectCredential(e.credential || "");
      const credPill =
        credInfo.status === "expired"
          ? '<span class="pill fail">已过期</span>'
          : credInfo.status === "ok" || credInfo.status === "unknown"
            ? '<span class="pill muted-pill">凭证</span>'
            : "";
      return `<button type="button" class="env-item ${isSel ? "selected" : ""} ${isActive ? "is-active" : ""}" data-id="${escapeHtml(e.id)}">
        <span class="env-item-name">${escapeHtml(e.name)}</span>
        <span class="env-item-meta">
          ${credPill}
          ${isActive ? '<span class="pill ok">启用中</span>' : ""}
        </span>
      </button>`;
    })
    .join("");
  $("envList").querySelectorAll("[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedEnvId = btn.dataset.id;
      fillEnvForm();
      renderEnvList();
    });
  });
}

function fillEnvForm() {
  const e = selectedEnv();
  if (!e) return;
  $("envDetailTitle").textContent = e.name || "配置";
  $("envName").value = e.name || "";
  $("gateway").value = e.gateway || "";
  $("kafkaBrokers").value = e.kafkaBrokers || "127.0.0.1:9092";
  if ($("minioEndpoint")) $("minioEndpoint").value = e.minioEndpoint || "http://leidian-minio:9000";
  if ($("minioAccessKey")) $("minioAccessKey").value = e.minioAccessKey || "minioadmin";
  if ($("minioSecretKey")) $("minioSecretKey").value = e.minioSecretKey || "minioadmin";
  if ($("minioRadarBucket")) $("minioRadarBucket").value = e.minioRadarBucket || "leidian-frame";
  $("loginUser").value = e.username || "";
  $("loginPass").value = e.password || "";
  $("credential").value = e.credential || "";
  renderPrefixTable(e);
  updateLoginPreview(e);
  updateCredStatus(e.credential);
  $("envHint").textContent = "";
  const isActive = e.id === state.envDoc?.activeId;
  $("btnActivateEnv").disabled = isActive;
  $("btnActivateEnv").textContent = isActive ? "已启用" : "启用";
  $("loginPass").placeholder = e.hasPassword ? "已保存（留空不改）" : "";
}

function renderPrefixTable(env) {
  const services = state.envDoc?.services || [];
  const prefixes = env.prefixes || {};
  const gateway = ($("gateway").value || env.gateway || "").replace(/\/$/, "");
  $("prefixBody").innerHTML = services
    .map((s) => {
      const prefix = prefixes[s.id] ?? s.prefix ?? "";
      const full = gateway ? `${gateway}${prefix}` : prefix;
      return `<tr>
        <td><strong>${escapeHtml(s.name)}</strong><div class="sub">${escapeHtml(s.id)}</div></td>
        <td><input class="prefix-input" data-service="${escapeHtml(s.id)}" type="text" value="${escapeHtml(prefix)}" /></td>
        <td class="prefix-full" data-full-for="${escapeHtml(s.id)}">${escapeHtml(full)}</td>
      </tr>`;
    })
    .join("");
  $("prefixBody").querySelectorAll(".prefix-input").forEach((input) => {
    input.addEventListener("input", refreshPrefixFulls);
  });
}

function collectPrefixes() {
  const prefixes = {};
  document.querySelectorAll(".prefix-input").forEach((input) => {
    prefixes[input.dataset.service] = input.value.trim();
  });
  return prefixes;
}

function refreshPrefixFulls() {
  const gateway = ($("gateway").value || "").replace(/\/$/, "");
  document.querySelectorAll(".prefix-input").forEach((input) => {
    const sid = input.dataset.service;
    const cell = document.querySelector(`[data-full-for="${sid}"]`);
    if (cell) {
      const prefix = input.value.trim();
      cell.textContent = gateway ? `${gateway}${prefix}` : prefix;
    }
  });
  updateLoginPreview({
    gateway,
    prefixes: collectPrefixes(),
    loginApi: selectedEnv()?.loginApi || "/auth/login",
  });
}

function updateLoginPreview(env) {
  const gateway = (env.gateway || "").replace(/\/$/, "");
  const systemPrefix = (env.prefixes?.system || "/api/system").replace(/\/$/, "");
  const api = env.loginApi || "/auth/login";
  const url = gateway ? `${gateway}${systemPrefix}${api}` : "";
  $("loginUrlPreview").textContent = url ? `登录：${url}` : "登录：填写网关后自动拼接 system 前缀";
}

function collectEnvForm() {
  const e = selectedEnv();
  if (!e) throw new Error("无环境");
  return {
    id: e.id,
    name: $("envName").value.trim() || "未命名",
    gateway: $("gateway").value.trim(),
    kafkaBrokers: ($("kafkaBrokers").value || "").trim() || "127.0.0.1:9092",
    minioEndpoint: ($("minioEndpoint")?.value || "").trim() || "http://leidian-minio:9000",
    minioAccessKey: ($("minioAccessKey")?.value || "").trim() || "minioadmin",
    minioSecretKey: ($("minioSecretKey")?.value || "").trim() || "minioadmin",
    minioRadarBucket: ($("minioRadarBucket")?.value || "").trim() || "leidian-frame",
    prefixes: collectPrefixes(),
    username: $("loginUser").value.trim(),
    password: $("loginPass").value,
    credential: $("credential").value.trim(),
    loginApi: e.loginApi || "/auth/login",
    tokenPath: e.tokenPath || "data.accessToken",
  };
}

function applyEnvDoc(data) {
  state.envDoc = data;
  if (!state.selectedEnvId || !data.environments.some((e) => e.id === state.selectedEnvId)) {
    state.selectedEnvId = data.activeId || data.environments[0]?.id;
  }
  renderEnvList();
  fillEnvForm();
  updateActiveBadge();
}

async function loadEnv() {
  const { data } = await api("/api/env");
  applyEnvDoc(data);
}

async function saveEnv() {
  const { data } = await api("/api/env/upsert", {
    method: "POST",
    body: JSON.stringify(collectEnvForm()),
  });
  applyEnvDoc(data);
  $("envHint").textContent = "已保存";
}

async function addEnv() {
  const { data } = await api("/api/env/create", {
    method: "POST",
    body: JSON.stringify({ name: "新环境" }),
  });
  state.selectedEnvId = data.environments[data.environments.length - 1]?.id;
  applyEnvDoc(data);
}

async function activateEnv() {
  const e = selectedEnv();
  if (!e) return;
  try {
    await saveEnv();
  } catch (_) {
    /* keep going to activate */
  }
  const { data } = await api("/api/env/activate", {
    method: "POST",
    body: JSON.stringify({ id: e.id }),
  });
  applyEnvDoc(data);
  $("envHint").textContent = "已启用";
}

async function deleteEnv() {
  const e = selectedEnv();
  if (!e) return;
  if ((state.envDoc?.environments || []).length <= 1) {
    $("envHint").textContent = "至少保留一个环境";
    return;
  }
  if (!confirm(`删除「${e.name}」？`)) return;
  const { data } = await api(`/api/env/items/${encodeURIComponent(e.id)}`, { method: "DELETE" });
  state.selectedEnvId = data.activeId;
  applyEnvDoc(data);
}

async function fetchToken() {
  const e = selectedEnv();
  if (!e) return;
  const hint = $("fetchHint") || $("envHint");
  hint.className = "inline-hint";
  hint.textContent = "获取中…";
  try {
    await saveEnv();
    const { data } = await api("/api/env/fetch-token", {
      method: "POST",
      body: JSON.stringify({ id: e.id }),
    });
    applyEnvDoc(data);
    hint.className = "inline-hint ok";
    hint.textContent = "凭证已写入";
    $("envHint").textContent = "凭证已写入";
  } catch (err) {
    const msg = String(err.message || err);
    hint.className = "inline-hint warn";
    hint.textContent = msg;
    $("envHint").className = "inline-hint warn";
    $("envHint").textContent = msg;
  }
}

async function clearCredential() {
  const e = selectedEnv();
  if (!e) return;
  const { data } = await api("/api/env/clear-credential", {
    method: "POST",
    body: JSON.stringify({ id: e.id }),
  });
  applyEnvDoc(data);
  $("envHint").textContent = "已清除";
}

function renderCapabilityNav(containerId, activeId, onSelect) {
  const el = $(containerId);
  el.innerHTML = state.capabilities
    .map((c) => {
      const on = c.id === activeId;
      const count = (c.modules || []).length;
      return `<button type="button" class="env-item ${on ? "selected" : ""}" data-capability="${escapeHtml(c.id)}">
        <span class="env-item-name">${escapeHtml(c.name)}</span>
        <span class="env-item-meta">
          <span class="pill muted-pill">${count} 组</span>
          ${on ? '<span class="pill ok">当前</span>' : ""}
        </span>
      </button>`;
    })
    .join("");
  el.querySelectorAll("[data-capability]").forEach((btn) => {
    btn.addEventListener("click", () => onSelect(btn.dataset.capability));
  });
}

function bindCapabilityNavs() {
  renderCapabilityNav("moduleNav", state.currentCapability, async (id) => {
    state.currentCapability = id;
    bindCapabilityNavs();
    await reloadCases();
  });
  renderCapabilityNav("runModuleNav", state.runCapability, async (id) => {
    state.runCapability = id;
    bindCapabilityNavs();
    await reloadRunCases();
  });
}

function fillModuleSelect(selectedModuleId) {
  const cap = capabilityById(state.currentCapability);
  const modules = cap?.modules || [];
  $("caseModule").innerHTML = modules
    .map(
      (m) =>
        `<option value="${escapeHtml(m.id)}" ${m.id === selectedModuleId ? "selected" : ""}>${escapeHtml(m.name)}</option>`
    )
    .join("");
}

function caseKey(module, id) {
  return `${module}::${id}`;
}

function runStatusMeta(status) {
  switch (status) {
    case "queued":
      return { label: "排队中", cls: "run-st-queued" };
    case "running":
      return { label: "执行中", cls: "run-st-running" };
    case "passed":
      return { label: "执行成功", cls: "run-st-passed" };
    case "failed":
      return { label: "执行失败", cls: "run-st-failed" };
    case "skipped":
      return { label: "已跳过", cls: "run-st-skipped" };
    default:
      return { label: "", cls: "" };
  }
}

function formatRunDetail(result) {
  if (!result) return "暂无执行结果";
  const lines = [];
  const st = runStatusMeta(result.status);
  if (st.label) lines.push(`状态：${st.label}`);
  if (result.reason) lines.push(`说明：${result.reason}`);
  const steps = Array.isArray(result.steps) ? result.steps : [];
  if (!steps.length && result.status === "passed") {
    lines.push("步骤均通过。");
  }
  steps.forEach((step, i) => {
    const n = i + 1;
    const title =
      step.title ||
      step.name ||
      (step.method || step.path
        ? `${step.method || "GET"} ${step.path || ""}`.trim()
        : `步骤 ${n}`);
    const outcome =
      step.status === "passed" ? "通过" : step.status === "failed" ? "失败" : step.status || "";
    lines.push(`步骤 ${n}：${title}`);

    const detailBits = [];
    if (step.method || step.path) {
      detailBits.push(`${step.method || "GET"} ${step.path || ""}`.trim());
    }
    if (step.expectStatus != null) detailBits.push(`期望 HTTP ${step.expectStatus}`);
    if (step.httpStatus != null) detailBits.push(`实际 HTTP ${step.httpStatus}`);
    if (outcome) detailBits.push(outcome);
    if (step.reason) detailBits.push(step.reason);
    const body = step.body;
    if (body && typeof body === "object") {
      if (body.message) detailBits.push(`响应 ${body.message}`);
      else if (body.code != null) detailBits.push(`响应 code=${body.code}`);
    }
    if (detailBits.length) {
      lines.push(`  ${detailBits.join(" · ")}`);
    }
  });
  return lines.join("\n");
}

function renderCaseRow(c, { selectable }) {
  const skipCls = c.skip ? "skip-card" : "";
  const checked = c.skip ? "" : "checked";
  const moduleId = c.module;
  const key = caseKey(moduleId, c.id);
  const desc = (c.description || "").trim();
  const descHtml = desc
    ? `<p class="case-desc">${escapeHtml(desc)}</p>`
    : `<p class="case-desc muted">暂无说明</p>`;
  const result = state.runResults[key];
  const st = runStatusMeta(result?.status);
  const expanded = state.expandedRunKey === key && result && ["passed", "failed", "skipped"].includes(result.status);
  const clickable = selectable && result && ["passed", "failed", "skipped"].includes(result.status);
  const deviceTypes = Array.isArray(c.deviceTypes) ? c.deviceTypes : [];
  const deviceTypesAttr = escapeHtml(deviceTypes.join(","));

  const title = selectable
    ? `<label class="case-check"><input type="checkbox" class="run-check" data-id="${escapeHtml(c.id)}" data-module="${escapeHtml(moduleId)}" data-expand="${c.expandByDeviceType ? "1" : "0"}" ${checked} /><span class="env-item-name"><span class="case-id">${escapeHtml(c.id)}</span> <span class="case-name">${escapeHtml(c.name)}</span></span></label>`
    : `<span class="env-item-name"><span class="case-id">${escapeHtml(c.id)}</span> <span class="case-name">${escapeHtml(c.name)}</span></span>`;

  const meta = [];
  if (selectable && st.label) {
    meta.push(`<span class="pill run-status-pill ${st.cls}" data-run-status>${escapeHtml(st.label)}</span>`);
  }
  if (c.skip) meta.push('<span class="pill warn">跳过</span>');
  if (c.expandByDeviceType) meta.push('<span class="pill muted-pill">按所选类型展开</span>');
  else if (c.expandByNetwork) meta.push('<span class="pill muted-pill">按所选网络展开</span>');
  else if (selectable && (state.runCapability === "device-ingest" || state.runCapability === "device-monitor")) meta.push('<span class="pill muted-pill">通用</span>');
  else if (selectable && state.runCapability === "lightning-ingest") meta.push('<span class="pill muted-pill">通用</span>');
  else if (selectable && state.runCapability === "radar-frame-ingest") meta.push('<span class="pill muted-pill">通用</span>');
  if (c.sub) meta.push(`<span class="pill muted-pill">${escapeHtml(c.sub)}</span>`);

  const actions = selectable
    ? `<span class="env-item-meta">${meta.join("")}<button type="button" class="btn tiny secondary" data-run-one data-id="${escapeHtml(c.id)}" data-module="${escapeHtml(moduleId)}" ${c.skip ? "disabled" : ""}>执行</button></span>`
    : `<span class="env-item-meta">${meta.join("")}<button type="button" class="btn tiny secondary" data-edit="${escapeHtml(c.id)}" data-module="${escapeHtml(moduleId)}">编辑</button></span>`;

  const detailHtml = selectable
    ? `<pre class="case-run-detail" ${expanded ? "" : "hidden"}>${escapeHtml(formatRunDetail(result))}</pre>`
    : "";

  return `<div class="env-item case-row ${skipCls}${selectable ? " run-case-row" : ""}${clickable ? " is-clickable" : ""}${expanded ? " is-expanded" : ""}" data-case-key="${escapeHtml(key)}" data-id="${escapeHtml(c.id)}" data-module="${escapeHtml(moduleId)}" data-device-types="${deviceTypesAttr}">
    <div class="case-row-left">
      ${title}
      ${descHtml}
      ${detailHtml}
    </div>
    ${actions}
  </div>`;
}

function deviceTypeName(id) {
  const hit = state.deviceTypes.find((t) => t.id === id);
  return hit?.name || id;
}

function ensureDeviceTypeSelection() {
  // 仅在尚未初始化时默认全选；空集合表示用户主动全不选，不得再灌回全选
  if (!state.deviceTypes.length) return;
  if (state._deviceTypesReady) return;
  state.selectedDeviceTypes = new Set(state.deviceTypes.map((t) => t.id));
  state._deviceTypesReady = true;
}

function renderDeviceTypeFilter() {
  const panel = $("deviceTypeFilter");
  const list = $("deviceTypeFilterList");
  if (!panel || !list) return;
  const show = (state.runCapability === "device-ingest" || state.runCapability === "device-monitor") && state.deviceTypes.length > 0;
  panel.hidden = !show;
  if (!show) return;
  ensureDeviceTypeSelection();
  list.innerHTML = state.deviceTypes
    .map((t) => {
      const checked = state.selectedDeviceTypes.has(t.id) ? "checked" : "";
      return `<label class="device-type-chip"><input type="checkbox" class="device-type-check" data-type="${escapeHtml(t.id)}" ${checked} /><span>${escapeHtml(t.name)}</span></label>`;
    })
    .join("");
  const allOn =
    state.deviceTypes.length > 0 &&
    state.deviceTypes.every((t) => state.selectedDeviceTypes.has(t.id));
  if ($("deviceTypeCheckAll")) $("deviceTypeCheckAll").checked = allOn;
}

function caseMatchesDeviceFilter(deviceTypesCsv) {
  const types = String(deviceTypesCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // 公共用例：始终匹配
  if (!types.length) return true;
  return types.some((t) => state.selectedDeviceTypes.has(t));
}

function ensureNetworkSelection() {
  if (!state.networks.length) return;
  if (state._networksReady) return;
  state.selectedNetworks = new Set(state.networks.map((n) => n.id));
  state._networksReady = true;
}

function renderNetworkFilter() {
  const panel = $("networkFilter");
  const list = $("networkFilterList");
  if (!panel || !list) return;
  const show = state.runCapability === "lightning-ingest" && state.networks.length > 0;
  panel.hidden = !show;
  if (!show) return;
  ensureNetworkSelection();
  list.innerHTML = state.networks
    .map((n) => {
      const checked = state.selectedNetworks.has(n.id) ? "checked" : "";
      return `<label class="device-type-chip"><input type="checkbox" class="network-check" data-network="${escapeHtml(n.id)}" ${checked} /><span>${escapeHtml(n.name)}</span></label>`;
    })
    .join("");
  const allOn =
    state.networks.length > 0 &&
    state.networks.every((n) => state.selectedNetworks.has(n.id));
  if ($("networkCheckAll")) $("networkCheckAll").checked = allOn;
}

function applyNetworkFilterToCases() {
  if (state.runCapability !== "lightning-ingest") return;
  document.querySelectorAll("#runCaseCardList .run-case-row").forEach((row) => {
    row.hidden = false;
    const check = row.querySelector(".run-check");
    if (!check) return;
    const skip = row.classList.contains("skip-card");
    check.checked = !skip;
  });
  const checks = [...document.querySelectorAll("#runCaseCardList .run-check")];
  $("checkAll").checked = checks.length > 0 && checks.every((c) => c.checked);
  const netCount = state.selectedNetworks.size;
  const expandCount = document.querySelectorAll('#runCaseCardList .run-check[data-expand="1"]:checked').length;
  $("runCaseCountHint").textContent =
    netCount > 0
      ? `已选 ${netCount} 个网络 · 展开用例 ${expandCount} 条`
      : `未选网络（展开用例将按全部网络执行）`;
}

function applyDeviceTypeFilterToCases() {
  if (state.runCapability !== "device-ingest" && state.runCapability !== "device-monitor") return;
  // 用例列表固定通用；设备多选只影响开跑时的展开参数
  document.querySelectorAll("#runCaseCardList .run-case-row").forEach((row) => {
    row.hidden = false;
    const check = row.querySelector(".run-check");
    const runBtn = row.querySelector("[data-run-one]");
    if (!check) return;
    const skip = row.classList.contains("skip-card");
    check.checked = !skip;
    if (runBtn) runBtn.disabled = !!skip;
  });
  const checks = [...document.querySelectorAll("#runCaseCardList .run-check")];
  $("checkAll").checked = checks.length > 0 && checks.every((c) => c.checked);
  const typeCount = state.selectedDeviceTypes.size;
  const expandCount = document.querySelectorAll('#runCaseCardList .run-check[data-expand="1"]:checked').length;
  $("runCaseCountHint").textContent =
    typeCount > 0
      ? `已选 ${typeCount} 种类型 · 展开用例 ${expandCount} 条`
      : `未选类型（展开用例将按全部类型执行）`;
}

function renderGroupedCases(containerId, tree, { selectable }) {
  const el = $(containerId);
  const groups = tree?.groups || [];
  if (!groups.length) {
    el.innerHTML = `<p class="placeholder">暂无用例</p>`;
    return;
  }
  el.innerHTML = groups
    .map((g) => {
      const cases = g.cases || [];
      const body = cases.length
        ? cases.map((c) => renderCaseRow(c, { selectable })).join("")
        : `<p class="placeholder group-empty">本组暂无用例</p>`;
      const newBtn = selectable
        ? ""
        : `<button type="button" class="btn tiny secondary" data-new-module="${escapeHtml(g.id)}">新建</button>`;
      return `<section class="case-group" data-group="${escapeHtml(g.id)}">
        <div class="case-group-head">
          <div class="case-group-title">
            <h3>${escapeHtml(g.name)}</h3>
            <span class="pill muted-pill">${g.caseCount ?? cases.length} 条</span>
          </div>
          ${newBtn}
        </div>
        <div class="case-card-list">${body}</div>
      </section>`;
    })
    .join("");

  el.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => editCase(btn.dataset.module, btn.dataset.edit));
  });
  el.querySelectorAll("[data-new-module]").forEach((btn) => {
    btn.addEventListener("click", () => newCase(btn.dataset.newModule));
  });
  el.querySelectorAll("[data-run-one]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startRun([{ module: btn.dataset.module, id: btn.dataset.id }]).catch((e) => {
        $("runHint").className = "inline-hint warn";
        $("runHint").textContent = String(e.message || e);
      });
    });
  });

  if (selectable) {
    el.querySelectorAll(".run-case-row").forEach((row) => {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest("input, label.case-check, button, a")) return;
        const key = row.dataset.caseKey;
        const result = state.runResults[key];
        if (!result || !["passed", "failed", "skipped"].includes(result.status)) return;
        state.expandedRunKey = state.expandedRunKey === key ? "" : key;
        applyRunStatusesToDom();
      });
    });
  }
}

function setCaseRunStatus(key, patch) {
  state.runResults[key] = { ...(state.runResults[key] || {}), ...patch, key };
}

function applyRunStatusesToDom() {
  document.querySelectorAll("#runCaseCardList .run-case-row").forEach((row) => {
    const key = row.dataset.caseKey;
    const result = state.runResults[key];
    const meta = row.querySelector(".env-item-meta");
    let pill = row.querySelector("[data-run-status]");
    const st = runStatusMeta(result?.status);
    if (st.label) {
      if (!pill && meta) {
        pill = document.createElement("span");
        pill.dataset.runStatus = "1";
        pill.className = "pill run-status-pill";
        meta.prepend(pill);
      }
      if (pill) {
        pill.className = `pill run-status-pill ${st.cls}`;
        pill.textContent = st.label;
      }
    } else if (pill) {
      pill.remove();
    }

    const canOpen = result && ["passed", "failed", "skipped"].includes(result.status);
    row.classList.toggle("is-clickable", !!canOpen);
    const open = state.expandedRunKey === key && canOpen;
    row.classList.toggle("is-expanded", !!open);
    let detail = row.querySelector(".case-run-detail");
    if (!detail) {
      detail = document.createElement("pre");
      detail.className = "case-run-detail";
      row.querySelector(".case-row-left")?.appendChild(detail);
    }
    if (open) {
      detail.hidden = false;
      detail.textContent = formatRunDetail(result);
    } else {
      detail.hidden = true;
    }
  });
}

function syncRunStatusesFromProgress(snap, queueKeys) {
  const results = snap.results || [];
  /** @type {Record<string, any[]>} */
  const groups = {};
  results.forEach((r) => {
    if (!r) return;
    const key = r.module && r.caseId ? caseKey(r.module, r.caseId) : "";
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  queueKeys.forEach((key) => {
    const id = key.split("::")[1];
    const hits = groups[key] || [];
    if (hits.length) {
      setCaseRunStatus(key, aggregateCaseResults(id, hits));
    } else if (snap.phase === "running" && String(snap.currentCaseId || "").split("@")[0] === id) {
      setCaseRunStatus(key, {
        status: "running",
        caseId: id,
        name: snap.currentName || id,
        reason: "",
        steps: [],
      });
    } else if (snap.phase === "running" && !state.runResults[key]?.status) {
      setCaseRunStatus(key, { status: "queued", caseId: id, reason: "", steps: [] });
    }
  });

  if (snap.phase === "running" && snap.currentCaseId) {
    const curId = String(snap.currentCaseId).split("@")[0];
    queueKeys.forEach((key) => {
      const id = key.split("::")[1];
      const cur = state.runResults[key]?.status;
      if (id === curId && cur !== "passed" && cur !== "failed" && cur !== "skipped") {
        setCaseRunStatus(key, {
          status: "running",
          caseId: id,
          name: snap.currentName || id,
          reason: "",
          steps: state.runResults[key]?.steps || [],
        });
      }
    });
  }

  applyRunStatusesToDom();
  const s = snap.summary || {};
  if ($("runSummaryHint")) {
    if (snap.phase === "running") {
      $("runSummaryHint").textContent = `进度 ${snap.done || 0}/${snap.total || 0}`;
    } else if (snap.phase === "done" || snap.phase === "error") {
      $("runSummaryHint").textContent = `通过 ${s.passed || 0} · 失败 ${s.failed || 0} · 跳过 ${s.skipped || 0}`;
    }
  }
}

function aggregateCaseResults(caseId, hits) {
  const failed = hits.filter((r) => r.status === "failed");
  const skipped = hits.filter((r) => r.status === "skipped");
  const passed = hits.filter((r) => r.status === "passed");
  let status = "passed";
  if (failed.length) status = "failed";
  else if (skipped.length === hits.length) status = "skipped";
  else if (passed.length) status = "passed";
  else status = "skipped";

  const reasons = [];
  if (hits.length > 1) {
    reasons.push(`展开 ${hits.length} 次：过${passed.length} 败${failed.length} 跳${skipped.length}`);
  }
  failed.slice(0, 3).forEach((r) => {
    if (r.reason) reasons.push(`${r.deviceType || r.name || ""}: ${r.reason}`.trim());
  });
  if (!failed.length && skipped[0]?.reason) reasons.push(skipped[0].reason);

  return {
    caseId,
    name: hits[0]?.name || caseId,
    status,
    reason: reasons.join("\n"),
    steps:
      hits.length === 1
        ? hits[0].steps || []
        : hits.flatMap((r, i) => {
            const prefix = r.deviceType || r.instanceId || `#${i + 1}`;
            return (r.steps || []).map((s) => ({
              ...s,
              name: `[${prefix}] ${s.name || s.path || ""}`,
            }));
          }),
    instances: hits,
  };
}

async function reloadCases() {
  $("moduleTitle").textContent = capabilityName(state.currentCapability);
  const { data } = await api(`/api/cases?capability=${encodeURIComponent(state.currentCapability)}`);
  $("caseCountHint").textContent = `共 ${data.caseCount || 0} 条`;
  renderGroupedCases("caseCardList", data, { selectable: false });
}

async function reloadRunCases() {
  $("runModuleTitle").textContent = capabilityName(state.runCapability);
  const { data } = await api(`/api/cases?capability=${encodeURIComponent(state.runCapability)}`);
  $("runCaseCountHint").textContent = `共 ${data.caseCount || 0} 条`;
  renderGroupedCases("runCaseCardList", data, { selectable: true });
  renderDeviceTypeFilter();
  renderNetworkFilter();
  if (state.runCapability === "device-ingest" || state.runCapability === "device-monitor") {
    applyDeviceTypeFilterToCases();
  } else if (state.runCapability === "lightning-ingest") {
    applyNetworkFilterToCases();
  } else {
    const checks = [...document.querySelectorAll("#runCaseCardList .run-check")];
    const allOn = checks.length > 0 && checks.every((c) => c.checked);
    $("checkAll").checked = allOn;
  }
}

async function editCase(module, id) {
  const { data } = await api(`/api/cases/${module}/${id}`);
  state.editingId = id;
  state.editingModule = module;
  fillModuleSelect(module);
  $("caseModule").disabled = true;
  $("caseEditor").hidden = false;
  $("caseId").value = data.id;
  $("caseId").readOnly = true;
  $("caseName").value = data.name || "";
  $("caseDescription").value = data.description || "";
  $("caseSkip").checked = !!data.skip;
  $("caseSkipReason").value = data.skipReason || "";
  $("caseSteps").value = JSON.stringify(data.steps || [], null, 2);
  $("caseHint").textContent = "";
  $("caseEditor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function newCase(moduleId) {
  const cap = capabilityById(state.currentCapability);
  const fallback = cap?.modules?.[0]?.id;
  const module = moduleId || fallback;
  state.editingId = null;
  state.editingModule = module;
  fillModuleSelect(module);
  $("caseModule").disabled = false;
  $("caseEditor").hidden = false;
  $("caseId").readOnly = false;
  $("caseId").value = "";
  $("caseName").value = "";
  $("caseDescription").value = "";
  $("caseSkip").checked = false;
  $("caseSkipReason").value = "";
  $("caseSteps").value = JSON.stringify(
    [
      {
        method: "GET",
        service: "biz",
        path: "/warning/rules",
        expect: { status: 200, fields: { code: 0 } },
      },
    ],
    null,
    2
  );
  $("caseHint").textContent = "";
  $("caseEditor").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveCase() {
  let steps;
  try {
    steps = JSON.parse($("caseSteps").value || "[]");
  } catch (e) {
    $("caseHint").textContent = "步骤 JSON 无效";
    return;
  }
  const module = $("caseModule").value || state.editingModule;
  const payload = {
    module,
    id: $("caseId").value.trim(),
    name: $("caseName").value.trim(),
    description: $("caseDescription").value.trim(),
    skip: $("caseSkip").checked,
    skipReason: $("caseSkipReason").value.trim(),
    steps,
  };
  await api("/api/cases", { method: "POST", body: JSON.stringify(payload) });
  $("caseHint").textContent = "已保存";
  state.editingModule = module;
  await reloadCases();
  if (state.runCapability === state.currentCapability) {
    await reloadRunCases();
  }
}

async function deleteCase() {
  const id = $("caseId").value.trim();
  const module = $("caseModule").value || state.editingModule;
  if (!id || !module) return;
  await api(`/api/cases/${module}/${id}`, { method: "DELETE" });
  $("caseEditor").hidden = true;
  await reloadCases();
  if (state.runCapability === state.currentCapability) {
    await reloadRunCases();
  }
}

function renderRunProgress(snap) {
  const panel = $("runProgressPanel");
  if (!panel) return;
  const total = snap.total || 0;
  const done = snap.done || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  panel.hidden = false;
  $("runProgressCount").textContent = `${done} / ${total}`;
  $("runProgressBar").style.width = `${pct}%`;
  if (snap.phase === "running") {
    const cur = snap.currentName || snap.currentCaseId || "准备中";
    $("runProgressText").textContent = `正在执行：${cur}`;
    if (!snap.currentCaseId && done === 0) {
      $("runProgressText").textContent = `已启动，共 ${total} 条`;
    }
  } else if (snap.phase === "done") {
    const s = snap.summary || {};
    $("runProgressText").textContent = `完成：通过 ${s.passed || 0}，失败 ${s.failed || 0}，跳过 ${s.skipped || 0}`;
    $("runProgressBar").style.width = "100%";
    $("runProgressCount").textContent = `${total} / ${total}`;
  } else if (snap.phase === "error") {
    $("runProgressText").textContent = `中断：${snap.error || "未知错误"}`;
  }
}

function setRunControlsDisabled(disabled) {
  const btn = $("btnRun");
  if (btn) btn.disabled = disabled;
  document.querySelectorAll("#runCaseCardList [data-run-one]").forEach((b) => {
    if (disabled) {
      b.disabled = true;
    } else {
      // skip 用例保持不可点
      const row = b.closest(".run-case-row");
      b.disabled = !!row?.classList.contains("skip-card");
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Array<{module:string,id:string}>|null} caseRefs 传入则只跑这些；否则跑勾选项
 */
async function startRun(caseRefs = null) {
  let refs = caseRefs;
  if (!refs || !refs.length) {
    const checks = [...document.querySelectorAll("#runCaseCardList .run-check:checked")];
    if (!checks.length) {
      $("runHint").className = "inline-hint warn";
      $("runHint").textContent = "请至少勾选一条用例，或点某条后面的「执行」";
      return;
    }
    refs = checks.map((c) => ({ module: c.dataset.module, id: c.dataset.id }));
  }

  const credInfo = inspectCredential(state.envDoc?.active?.credential || "");
  if (credInfo.status === "missing" || credInfo.status === "expired") {
    $("runHint").className = "inline-hint warn";
    $("runHint").textContent = credInfo.message;
    updateCredStatus(state.envDoc?.active?.credential || "");
    updateActiveBadge();
    return;
  }

  if (state.runBusy) {
    $("runHint").className = "inline-hint warn";
    $("runHint").textContent = "已有执行进行中，请稍候";
    return;
  }
  state.runBusy = true;

  setRunControlsDisabled(true);
  $("jobBadge").textContent = refs.length === 1 ? "执行中" : "跑批中";
  $("jobBadge").className = "job-badge running";
  $("runHint").className = "inline-hint";
  $("runHint").textContent =
    refs.length === 1 ? `正在单独执行：${refs[0].id}` : "已开始，状态见各用例右侧";
  state.expandedRunKey = "";
  state.runQueueKeys = refs.map((r) => caseKey(r.module, r.id));
  state.runQueueKeys.forEach((key) => {
    const id = key.split("::")[1];
    setCaseRunStatus(key, { status: "queued", caseId: id, reason: "", steps: [] });
  });
  applyRunStatusesToDom();
  $("runProgressPanel").hidden = false;
  $("runProgressBar").style.width = "0%";
  $("runProgressText").textContent =
    refs.length === 1 ? `单独执行 ${refs[0].id}` : `准备执行 ${state.runQueueKeys.length} 条…`;
  $("runProgressCount").textContent = `0 / ${state.runQueueKeys.length}`;

  try {
    await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        cases: refs,
        deviceTypes:
          state.runCapability === "device-ingest" || state.runCapability === "device-monitor"
            ? [...state.selectedDeviceTypes]
            : undefined,
        networks:
          state.runCapability === "lightning-ingest"
            ? [...state.selectedNetworks]
            : undefined,
      }),
    });

    let snap = null;
    for (;;) {
      const res = await api("/api/run/progress");
      snap = res.data || {};
      renderRunProgress(snap);
      syncRunStatusesFromProgress(snap, state.runQueueKeys);
      $("runHint").textContent =
        snap.phase === "running"
          ? `执行中 ${snap.done || 0}/${snap.total || 0}（点成功/失败用例可看详情）`
          : snap.phase === "done"
            ? "执行完成，点成功/失败用例可展开详情"
            : snap.phase === "error"
              ? String(snap.error || "执行失败")
              : "执行中…";
      if (snap.phase === "done" || snap.phase === "error") break;
      await sleep(280);
    }

    if (snap.run?.results) {
      syncRunStatusesFromProgress({ ...snap, results: snap.run.results, phase: snap.phase }, state.runQueueKeys);
    }

    if (snap.phase === "error") {
      $("runHint").className = "inline-hint warn";
      $("jobBadge").textContent = "失败";
      $("jobBadge").className = "job-badge failed";
    } else {
      $("runHint").className = "inline-hint ok";
      $("jobBadge").textContent = "空闲";
      $("jobBadge").className = "job-badge idle";
      // 单条跑完自动展开详情
      if (refs.length === 1) {
        state.expandedRunKey = state.runQueueKeys[0];
        applyRunStatusesToDom();
      }
      await reloadHistory();
    }
  } catch (e) {
    $("runHint").className = "inline-hint warn";
    $("runHint").textContent = String(e.message || e);
    $("jobBadge").textContent = "失败";
    $("jobBadge").className = "job-badge failed";
    $("runProgressPanel").hidden = false;
    $("runProgressText").textContent = `启动失败：${e.message || e}`;
    throw e;
  } finally {
    state.runBusy = false;
    setRunControlsDisabled(false);
  }
}

async function reloadHistory() {
  const { data } = await api("/api/runs");
  $("historyBody").innerHTML = (data || [])
    .map((r) => {
      const s = r.summary || {};
      return `<tr>
        <td>${escapeHtml(r.id)}</td>
        <td>${escapeHtml(r.finishedAt || r.startedAt || "")}</td>
        <td>总${s.total || 0} 过${s.passed || 0} 败${s.failed || 0} 跳${s.skipped || 0}</td>
        <td><button type="button" class="btn tiny secondary" data-run="${escapeHtml(r.id)}">查看</button></td>
      </tr>`;
    })
    .join("") || `<tr><td colspan="4" class="placeholder">暂无历史</td></tr>`;
  $("historyBody").querySelectorAll("[data-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { data: detail } = await api(`/api/runs/${btn.dataset.run}`);
      $("historyDetail").textContent = JSON.stringify(detail, null, 2);
    });
  });
}

function bind() {
  document.querySelectorAll(".page-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
  });
  $("btnSaveEnv").addEventListener("click", () => saveEnv().catch((e) => ($("envHint").textContent = e.message)));
  $("btnAddEnv").addEventListener("click", () => addEnv().catch((e) => ($("envHint").textContent = e.message)));
  $("btnActivateEnv").addEventListener("click", () => activateEnv().catch((e) => ($("envHint").textContent = e.message)));
  $("btnDeleteEnv").addEventListener("click", () => deleteEnv().catch((e) => ($("envHint").textContent = e.message)));
  $("btnFetchToken").addEventListener("click", () => fetchToken());
  $("btnClearCred").addEventListener("click", () => clearCredential().catch((e) => ($("envHint").textContent = e.message)));
  $("credential").addEventListener("input", () => updateCredStatus($("credential").value.trim()));
  $("gateway").addEventListener("input", refreshPrefixFulls);
  $("btnReloadCases").addEventListener("click", () => reloadCases().catch(alert));
  $("btnSaveCase").addEventListener("click", () => saveCase().catch((e) => ($("caseHint").textContent = e.message)));
  $("btnDeleteCase").addEventListener("click", () => deleteCase().catch(alert));
  $("btnRun").addEventListener("click", () => startRun().catch((e) => {
    $("runHint").className = "inline-hint warn";
    $("runHint").textContent = String(e.message || e);
  }));
  $("btnReloadHistory").addEventListener("click", () => reloadHistory().catch(alert));
  $("checkAll").addEventListener("change", () => {
    const on = $("checkAll").checked;
    document.querySelectorAll("#runCaseCardList .run-case-row").forEach((row) => {
      const check = row.querySelector(".run-check");
      if (!check || row.classList.contains("skip-card")) return;
      check.checked = on;
    });
  });
  $("deviceTypeCheckAll")?.addEventListener("change", () => {
    const on = $("deviceTypeCheckAll").checked;
    state._deviceTypesReady = true;
    state.selectedDeviceTypes = on
      ? new Set(state.deviceTypes.map((t) => t.id))
      : new Set();
    // 只同步子项勾选，不要整页重绘（避免把「全不选」又灌回全选）
    document.querySelectorAll("#deviceTypeFilterList .device-type-check").forEach((el) => {
      el.checked = on;
    });
    applyDeviceTypeFilterToCases();
  });
  $("deviceTypeFilterList")?.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains("device-type-check")) return;
    const id = t.dataset.type;
    if (!id) return;
    if (t.checked) state.selectedDeviceTypes.add(id);
    else state.selectedDeviceTypes.delete(id);
    const allOn =
      state.deviceTypes.length > 0 &&
      state.deviceTypes.every((x) => state.selectedDeviceTypes.has(x.id));
    if ($("deviceTypeCheckAll")) $("deviceTypeCheckAll").checked = allOn;
    applyDeviceTypeFilterToCases();
  });
  $("networkCheckAll")?.addEventListener("change", () => {
    const on = $("networkCheckAll").checked;
    state._networksReady = true;
    state.selectedNetworks = on
      ? new Set(state.networks.map((n) => n.id))
      : new Set();
    document.querySelectorAll("#networkFilterList .network-check").forEach((el) => {
      el.checked = on;
    });
    applyNetworkFilterToCases();
  });
  $("networkFilterList")?.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains("network-check")) return;
    const id = t.dataset.network;
    if (!id) return;
    if (t.checked) state.selectedNetworks.add(id);
    else state.selectedNetworks.delete(id);
    const allOn =
      state.networks.length > 0 &&
      state.networks.every((x) => state.selectedNetworks.has(x.id));
    if ($("networkCheckAll")) $("networkCheckAll").checked = allOn;
    applyNetworkFilterToCases();
  });
}

async function boot() {
  bind();
  const res = await api("/api/modules");
  state.capabilities = res.data || [];
  state.labels = res.labels || {};
  state.deviceTypes = res.deviceTypes || [];
  state.selectedDeviceTypes = new Set(state.deviceTypes.map((t) => t.id));
  state._deviceTypesReady = true;
  state.networks = res.networks || [];
  state.selectedNetworks = new Set(state.networks.map((n) => n.id));
  state._networksReady = true;
  state.currentCapability = state.capabilities[0]?.id || "warn-rule";
  state.runCapability = state.currentCapability;
  bindCapabilityNavs();
  await loadEnv();
  await reloadCases();
  await reloadRunCases();
  await reloadHistory();
}

boot().catch((e) => console.error(e));
