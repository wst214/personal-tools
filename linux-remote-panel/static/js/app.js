let commandsData = { categories: [] };
let activeCategoryId = null;
let profiles = [];
let connected = false;
let currentCwd = "/";
let commandHistory = [];
let historyIndex = -1;
let statusInfo = { host: "", username: "", port: 22 };
let activeMainTab = "terminal";

const THEME_KEY = "linux-remote-theme";
const THEMES = ["hub", "codex"];

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "hub";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  $$(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === next);
  });
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "hub");
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function isSessionLostError(message) {
  return /未连接|not connected|connection lost|broken pipe|eof|socket is closed/i.test(message || "");
}

async function tryReconnect() {
  try {
    await api("/api/reconnect", { method: "POST", body: "{}" });
    await refreshStatus();
    return true;
  } catch {
    await refreshStatus();
    return false;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || "请求失败");
    return data;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.includes("Internal Server Error") ? "服务内部错误，请稍后重试" : "请求失败");
  }
  return res;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function updatePrompt() {
  const prompt = $("#command-prompt");
  prompt.textContent = connected
    ? `${statusInfo.username}@${statusInfo.host}:${currentCwd}$`
    : "$";
  updateWorkspaceMeta();
}

function updateWorkspaceMeta() {
  const meta = $("#workspace-meta");
  const dot = $("#ws-dot");
  const addr = $("#ws-addr");
  const cwd = $("#ws-cwd");
  if (!meta) return;

  meta.classList.toggle("is-offline", !connected);
  if (dot) dot.className = `dot ${connected ? "online" : "offline"}`;

  if (addr) {
    addr.textContent = connected
      ? `${statusInfo.username}@${statusInfo.host}:${statusInfo.port || 22}`
      : "尚未连接";
  }

  if (cwd) cwd.textContent = connected ? currentCwd : "";
}

function appendOutput(result, error = null, type = "run") {
  const output = $("#output");
  const block = document.createElement("div");
  block.className = "block";

  if (error) {
    block.innerHTML = `<div class="meta error">✗ ${escapeHtml(error)}</div>`;
  } else if (type === "info") {
    block.innerHTML = `<div class="meta info">${escapeHtml(result)}</div>`;
  } else {
    const statusClass = result.success ? "success" : "error";
    const statusText = result.success ? "成功" : `退出码 ${result.exit_code}`;
    block.innerHTML = `
      <div class="meta ${statusClass}">$ ${escapeHtml(result.command)} — ${statusText}</div>
      ${result.stdout ? `<div class="stdout">${escapeHtml(result.stdout.trimEnd())}</div>` : ""}
      ${result.stderr ? `<div class="stderr">${escapeHtml(result.stderr.trimEnd())}</div>` : ""}
    `;
  }

  output.appendChild(block);
  output.scrollTop = output.scrollHeight;
}

function setConnectionStatus(isConnected, host = "", username = "", port = 22) {
  connected = isConnected;
  statusInfo = { host, username, port: port || 22 };
  const status = $("#connection-status");
  status.querySelector(".dot").className = `dot ${isConnected ? "online" : "offline"}`;
  status.querySelector(".status-text").textContent = isConnected
    ? `已连接 ${username}@${host}`
    : "未连接";

  $("#btn-connect").disabled = isConnected;
  $("#btn-disconnect").disabled = !isConnected;
  updatePrompt();
  renderCommandGrid();
  renderProfiles();
}

async function refreshStatus() {
  try {
    const data = await api("/api/status");
    currentCwd = data.cwd || "/";
    setConnectionStatus(data.connected, data.host, data.username, data.port);
    $("#file-path").value = currentCwd;
  } catch {
    // 状态接口短暂失败时，不直接把 UI 标成未连接
  }
}

async function switchMainTab(tabId) {
  activeMainTab = tabId;
  $$(".main-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  $$(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tabId}`);
  });
  $("#main-layout")?.classList.toggle("has-cmd-panel", tabId === "terminal");
  $("#workspace-body")?.classList.toggle("on-terminal", tabId === "terminal");
  updateWorkspaceMeta();
  if (tabId === "files" || tabId === "monitor") {
    await refreshStatus();
    if (tabId === "files") loadFiles($("#file-path")?.value.trim() || currentCwd);
    if (tabId === "monitor") refreshMonitor();
  }
}

function insertCommand(command) {
  const input = $("#command-input");
  input.value = command;
  input.focus({ preventScroll: true });
  const len = command.length;
  input.setSelectionRange(len, len);
}

function getCommandSearchQuery() {
  return ($("#cmd-search")?.value || "").trim().toLowerCase();
}

function matchCommand(button, query) {
  if (!query) return true;
  const haystack = `${button.label} ${button.description || ""} ${button.command}`.toLowerCase();
  return haystack.includes(query);
}

function parentPath(path) {
  const norm = (path || "/").replace(/\/+$/, "") || "/";
  if (norm === "/") return "/";
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "/" : norm.slice(0, idx);
}

async function runCommand(command, buttonMeta = null, allowRetry = true) {
  const cmd = command.trim();
  if (!cmd) return;
  if (!connected) {
    appendOutput(null, "请先连接服务器");
    return;
  }
  if (buttonMeta?.confirm && !confirm(`确认执行？\n\n${cmd}`)) return;

  if (commandHistory[commandHistory.length - 1] !== cmd) {
    commandHistory.push(cmd);
  }
  historyIndex = commandHistory.length;

  try {
    const result = await api("/api/execute", {
      method: "POST",
      body: JSON.stringify({ command: cmd }),
    });
    if (result.cwd) currentCwd = result.cwd;
    updatePrompt();
    appendOutput(result);
    if ($("#panel-files").classList.contains("active")) loadFiles(currentCwd);
  } catch (err) {
    if (allowRetry && isSessionLostError(err.message) && (await tryReconnect())) {
      return runCommand(cmd, buttonMeta, false);
    }
    appendOutput(null, err.message);
    await refreshStatus();
  }
}

function createCmdItem(button) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "cmd-item";
  el.disabled = !connected;
  el.innerHTML = `
    <div class="cmd-item-top">
      <span class="cmd-item-label">${escapeHtml(button.label)}</span>
      <span class="cmd-item-action">填入 →</span>
    </div>
    <code class="cmd-item-code">${escapeHtml(button.command)}</code>
    ${button.description ? `<span class="cmd-item-desc">${escapeHtml(button.description)}</span>` : ""}
  `;
  el.addEventListener("click", () => insertCommand(button.command));
  return el;
}

function renderCommandGrid() {
  const grid = $("#command-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const query = getCommandSearchQuery();
  let hasAny = false;
  const categories = commandsData?.categories || [];

  categories.forEach((category) => {
    const buttons = category.buttons.filter((b) => matchCommand(b, query));
    if (!buttons.length) return;
    hasAny = true;

    const section = document.createElement("section");
    section.className = "cmd-section";
    section.innerHTML = `<h4 class="cmd-section-title">${escapeHtml(category.name)}</h4>`;

    const list = document.createElement("div");
    list.className = "cmd-section-list";
    buttons.forEach((button) => list.appendChild(createCmdItem(button)));
    section.appendChild(list);
    grid.appendChild(section);
  });

  if (!hasAny) {
    grid.innerHTML = `<p class="empty-hint">${query ? "无匹配命令" : "暂无命令"}</p>`;
  }
}

function showFileStatus(message) {
  const empty = $("#file-empty");
  if (!empty) return;
  empty.textContent = message;
  empty.classList.remove("hidden");
}

async function loadFiles(path, allowRetry = true) {
  const tbody = $("#file-list");
  const empty = $("#file-empty");
  if (!tbody || !empty) return;

  if (!connected) {
    tbody.innerHTML = "";
    showFileStatus("请先在左侧点击「连接」按钮");
    return;
  }

  const targetPath = (path || currentCwd || "/").trim() || "/";
  tbody.innerHTML = "";
  showFileStatus("加载中…");

  try {
    const data = await api(`/api/files?path=${encodeURIComponent(targetPath)}`);
    currentCwd = data.path || targetPath;
    $("#file-path").value = currentCwd;
    updatePrompt();
    renderFileList(data.entries || []);
  } catch (err) {
    tbody.innerHTML = "";
    if (allowRetry && isSessionLostError(err.message) && (await tryReconnect())) {
      return loadFiles(targetPath, false);
    }
    if (isSessionLostError(err.message)) {
      await refreshStatus();
      showFileStatus("连接已断开，请重新点击「连接」");
    } else {
      showFileStatus(`加载失败：${err.message}`);
      appendOutput(null, `文件列表失败: ${err.message}`);
    }
  }
}

function renderFileList(entries) {
  const tbody = $("#file-list");
  const empty = $("#file-empty");
  tbody.innerHTML = "";

  if (!entries?.length) {
    empty.classList.remove("hidden");
    empty.textContent = "目录为空";
    return;
  }
  empty.classList.add("hidden");

  entries.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.className = "file-row";
    tr.innerHTML = `
      <td><span class="file-name ${entry.is_dir ? "dir" : ""}">${entry.is_dir ? "📁 " : "📄 "}${escapeHtml(entry.name)}</span></td>
      <td>${entry.is_dir ? "—" : formatSize(entry.size)}</td>
      <td>${escapeHtml(entry.modified || "—")}</td>
      <td><div class="file-actions"></div></td>
    `;

    const actions = tr.querySelector(".file-actions");

    if (entry.is_dir) {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        loadFiles(entry.path);
      });
    } else {
      const downloadBtn = document.createElement("button");
      downloadBtn.textContent = "下载";
      downloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(`/api/files/download?path=${encodeURIComponent(entry.path)}`, "_blank");
      });
      actions.appendChild(downloadBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "删除";
      deleteBtn.className = "danger";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除 ${entry.name}？`)) return;
        try {
          const data = await api("/api/files/delete", {
            method: "POST",
            body: JSON.stringify({ path: entry.path }),
          });
          renderFileList(data.entries);
          currentCwd = data.path;
          $("#file-path").value = currentCwd;
        } catch (err) {
          alert(err.message);
        }
      });
      actions.appendChild(deleteBtn);
    }

    tbody.appendChild(tr);
  });
}

async function refreshMonitor(allowRetry = true) {
  const grid = $("#monitor-grid");
  if (!grid) return;

  if (!connected) {
    grid.innerHTML = '<p class="empty-hint">请先在左侧点击「连接」按钮</p>';
    return;
  }

  grid.innerHTML = '<p class="empty-hint">加载中…</p>';
  try {
    const data = await api("/api/system");
    const snapshot = data.snapshot || {};
    const labels = {
      hostname: "主机名",
      uptime: "运行时长",
      load: "系统负载",
      memory: "内存",
      disk: "磁盘",
      docker: "Docker",
    };
    const entries = Object.entries(snapshot);
    if (!entries.length) {
      grid.innerHTML = '<p class="empty-hint">暂无监控数据</p>';
      return;
    }
    grid.innerHTML = "";
    entries.forEach(([key, value]) => {
      const card = document.createElement("article");
      card.className = "monitor-card";
      card.innerHTML = `
        <div class="monitor-card-head">
          <h3>${labels[key] || key}</h3>
        </div>
        <div class="monitor-card-body">
          <pre>${escapeHtml(value)}</pre>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    if (allowRetry && isSessionLostError(err.message) && (await tryReconnect())) {
      return refreshMonitor(false);
    }
    if (isSessionLostError(err.message)) {
      await refreshStatus();
      grid.innerHTML = '<p class="empty-hint">连接已断开，请重新点击「连接」</p>';
    } else {
      grid.innerHTML = `<p class="empty-hint">加载失败：${escapeHtml(err.message)}</p>`;
      appendOutput(null, `系统监控失败: ${err.message}`);
    }
  }
}

function saveProfiles() {
  localStorage.setItem("linux-remote-profiles", JSON.stringify(profiles));
  renderProfiles();
}

function deleteProfile(index) {
  const profile = profiles[index];
  const label = getProfileAlias(profile);
  if (!confirm(`确定删除「${label}」？`)) return;
  profiles.splice(index, 1);
  saveProfiles();
}

function isProfileActive(profile) {
  if (!connected) return false;
  return (
    profile.host === statusInfo.host &&
    (profile.username || "root") === statusInfo.username
  );
}

function getProfileAlias(profile) {
  return (profile.alias || profile.name || "").trim() || "未命名服务器";
}

function getProfileAliasInput() {
  return ($("#profile-alias-input")?.value || $("#profile-alias")?.value || "").trim();
}

function setProfileAliasInput(alias) {
  const value = alias || "";
  if ($("#profile-alias-input")) $("#profile-alias-input").value = value;
  if ($("#profile-alias")) $("#profile-alias").value = value;
}

function saveCurrentProfile() {
  const form = getConnectionForm();
  if (!form.host) {
    alert("请先填写主机地址");
    return;
  }
  let alias = getProfileAliasInput();
  if (!alias) {
    const existing = profiles.findIndex((p) => p.host === form.host && p.username === form.username);
    if (existing >= 0) setProfileAliasInput(getProfileAlias(profiles[existing]));
    const dialog = $("#save-profile-dialog");
    dialog.showModal();
    $("#profile-alias")?.focus();
    $("#profile-alias")?.select();
    return;
  }
  persistProfile(alias, form);
}

function persistProfile(alias, form) {
  const profile = { alias, name: alias, ...form };
  const existing = profiles.findIndex((p) => p.host === form.host && p.username === form.username);
  if (existing >= 0) profiles[existing] = profile;
  else profiles.push(profile);
  saveProfiles();
}

function setupSaveProfileDialog() {
  const dialog = $("#save-profile-dialog");
  $("#btn-cancel-profile")?.addEventListener("click", () => dialog.close());
  $("#save-profile-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const alias = $("#profile-alias").value.trim();
    if (!alias) return;
    setProfileAliasInput(alias);
    persistProfile(alias, getConnectionForm());
    dialog.close();
  });
}

function appendProfileAddTile(list) {
  const add = document.createElement("button");
  add.type = "button";
  add.className = "profile-tile-add";
  add.innerHTML = `
    <span class="profile-tile-add-icon" aria-hidden="true">+</span>
    <span class="profile-tile-add-text">保存为快捷服务器</span>
  `;
  add.addEventListener("click", saveCurrentProfile);
  list.appendChild(add);
}

function renderProfiles() {
  const list = $("#profile-list");
  if (!list) return;
  list.innerHTML = "";
  if (!profiles.length) {
    list.innerHTML = '<div class="profile-empty"><span>暂无快捷服务器</span><span>填写左侧信息后保存</span></div>';
    appendProfileAddTile(list);
    return;
  }
  profiles.forEach((profile, index) => {
    const tile = document.createElement("article");
    tile.className = `profile-tile${isProfileActive(profile) ? " active" : ""}`;
    tile.tabIndex = 0;
    const alias = getProfileAlias(profile);
    const addr = `${profile.username || "root"}@${profile.host}:${profile.port || 22}`;
    const online = isProfileActive(profile);
    tile.innerHTML = `
      <div class="profile-tile-main">
        <span class="profile-tile-badge ${online ? "online" : "offline"}" title="${online ? "已连接" : "未连接"}">${online ? "在线" : "离线"}</span>
        <div class="profile-tile-body">
          <span class="profile-tile-name">${escapeHtml(alias)}</span>
          <span class="profile-tile-addr">${escapeHtml(addr)}</span>
        </div>
      </div>
    `;
    tile.addEventListener("click", (e) => {
      if (e.target.closest(".profile-tile-delete")) return;
      void connectProfile(profile);
    });
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void connectProfile(profile);
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "profile-tile-delete";
    delBtn.title = "删除";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProfile(index);
    });
    tile.appendChild(delBtn);
    list.appendChild(tile);
  });
  appendProfileAddTile(list);
}

async function connectProfile(profile) {
  loadProfile(profile);
  try {
    const res = await api("/api/connect", { method: "POST", body: JSON.stringify(getConnectionForm()) });
    currentCwd = res.cwd || "/";
    appendOutput({ command: "connect", stdout: res.message, stderr: "", exit_code: 0, success: true });
    await refreshStatus();
    renderCommandGrid();
    if ($("#panel-files")?.classList.contains("active")) loadFiles(currentCwd);
    if ($("#panel-monitor")?.classList.contains("active")) refreshMonitor();
  } catch (err) {
    appendOutput(null, err.message);
    renderProfiles();
  }
}

function loadProfile(profile) {
  $("#host").value = profile.host || "";
  $("#port").value = profile.port || 22;
  $("#username").value = profile.username || "root";
  setProfileAliasInput(getProfileAlias(profile));
  if (profile.password) $("#password").value = profile.password;
  if (profile.private_key) $("#private_key").value = profile.private_key;
}

const WSL_STORAGE_KEY = "linux-remote-wsl-username";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyWslHost(host = "") {
  if (host) $("#host").value = host;
  $("#port").value = 22;
}

async function loadWslDefaults() {
  try {
    const data = await api("/api/wsl/defaults");
    const defaults = data.defaults || {};
    if (defaults.host && !defaults.host.includes("docker.internal")) {
      $("#host").value = defaults.host;
    }
    if (defaults.port) $("#port").value = defaults.port;
    if (defaults.username) {
      $("#username").value = defaults.username;
      localStorage.setItem(WSL_STORAGE_KEY, defaults.username);
    }
    if (defaults.password) $("#password").value = defaults.password;
    if (defaults.private_key) $("#private_key").value = defaults.private_key;
    if (defaults.passphrase) $("#passphrase").value = defaults.passphrase;
  } catch {
    // optional local defaults file
  }
}

async function refreshWslHelperStatus() {
  const el = $("#wsl-helper-status");
  if (!el) return;
  try {
    const data = await api("/api/wsl/health");
    if (!data.ok) throw new Error("助手不可用");
    el.textContent = "助手已就绪";
    el.className = "wsl-helper-status ok";
    const cachedUser = localStorage.getItem(WSL_STORAGE_KEY);
    const shouldFetchInfo = !cachedUser || !$("#username").value || $("#username").value === "root";
    if (!shouldFetchInfo) return;
    try {
      const info = await api("/api/wsl/info");
      if (info.username) {
        localStorage.setItem(WSL_STORAGE_KEY, info.username);
        if (!$("#username").value || $("#username").value === "root") {
          $("#username").value = info.username;
        }
      }
    } catch {
      // ignore info errors when helper is up
    }
  } catch {
    el.textContent = "助手未运行";
    el.className = "wsl-helper-status warn";
  }
}

async function prepareWsl(openTerminal = false) {
  const result = await api("/api/wsl/prepare", {
    method: "POST",
    body: JSON.stringify({ open_terminal: openTerminal }),
  });
  await sleep(openTerminal ? 1200 : 800);
  return result;
}

async function connectWithForm() {
  const res = await api("/api/connect", { method: "POST", body: JSON.stringify(getConnectionForm()) });
  currentCwd = res.cwd || "/";
  appendOutput({ command: "connect", stdout: res.message, stderr: "", exit_code: 0, success: true });
  await refreshStatus();
  renderCommandGrid();
  if ($("#panel-files")?.classList.contains("active")) loadFiles(currentCwd);
  if ($("#panel-monitor")?.classList.contains("active")) refreshMonitor();
}

function hasAuthCredentials() {
  return Boolean(($("#password").value || "").length || $("#private_key").value.trim());
}

async function connectLocalWsl() {
  await loadWslDefaults();
  const savedUser = localStorage.getItem(WSL_STORAGE_KEY) || $("#username").value.trim();
  if (savedUser) $("#username").value = savedUser;
  if (!hasAuthCredentials()) {
    appendOutput(null, "请先填写 WSL 密码或私钥");
    $("#password").focus();
    return;
  }
  try {
    appendOutput("正在准备 WSL 并启动 SSH…", null, "info");
    const prepared = await prepareWsl(false);
    appendOutput(prepared.message || "WSL 已准备", null, prepared.ssh_running ? "info" : "error");
    if (!prepared.ssh_running) {
      appendOutput(null, "SSH 未就绪。请在 WSL 执行: sudo systemctl enable --now ssh.socket");
      return;
    }
    if (prepared.host) {
      applyWslHost(prepared.host);
    } else {
      appendOutput(null, "无法获取 WSL IP，请确认 wsl-helper 正在运行");
      return;
    }
    await connectWithForm();
  } catch (err) {
    appendOutput(null, err.message);
  }
}
function getConnectionForm() {
  return {
    host: $("#host").value.trim(),
    port: parseInt($("#port").value, 10) || 22,
    username: $("#username").value.trim() || "root",
    password: $("#password").value,
    private_key: $("#private_key").value.trim(),
    passphrase: $("#passphrase").value,
  };
}

function setupAddButtonDialog() {
  const dialog = $("#add-button-dialog");
  const select = $("#new-category");

  $("#btn-add-button").addEventListener("click", () => {
    select.innerHTML = "";
    commandsData.categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat.id;
      opt.textContent = cat.name;
      select.appendChild(opt);
    });
    if (activeCategoryId) select.value = activeCategoryId;
    dialog.showModal();
  });

  $("#btn-cancel-add").addEventListener("click", () => dialog.close());

  $("#add-button-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const categoryId = select.value;
    const label = $("#new-label").value.trim();
    const command = $("#new-command").value.trim();
    const description = $("#new-description").value.trim();
    const confirmExec = $("#new-confirm").checked;
    if (!label || !command) return;

    const id = `custom_${Date.now()}`;
    try {
      await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          categories: [{ id: categoryId, buttons: [{ id, label, command, description, confirm: confirmExec || undefined }] }],
        }),
      });
      const category = commandsData.categories.find((c) => c.id === categoryId);
      category?.buttons.push({ id, label, command, description, confirm: confirmExec || undefined });
      dialog.close();
      $("#new-label").value = "";
      $("#new-command").value = "";
      $("#new-description").value = "";
      $("#new-confirm").checked = false;
      renderCommandGrid();
    } catch (err) {
      alert(err.message);
    }
  });
}

function bindEvents() {
  $$(".main-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      void switchMainTab(btn.dataset.tab);
    });
  });

  $("#connect-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await connectWithForm();
    } catch (err) {
      appendOutput(null, err.message);
    }
  });

  $("#btn-wsl-open").addEventListener("click", async () => {
    try {
      const result = await prepareWsl(true);
      appendOutput(result.message || "已打开 WSL 终端", null, "info");
      await refreshWslHelperStatus();
    } catch (err) {
      appendOutput(null, err.message);
    }
  });

  $("#btn-wsl-start-ssh").addEventListener("click", async () => {
    try {
      await loadWslDefaults();
      const savedUser = localStorage.getItem(WSL_STORAGE_KEY);
      if (savedUser) $("#username").value = savedUser;
      const result = await prepareWsl(false);
      appendOutput(result.message || "SSH 已启动", null, "info");
      await refreshWslHelperStatus();
    } catch (err) {
      appendOutput(null, err.message);
    }
  });

  $("#btn-wsl-connect").addEventListener("click", () => {
    void connectLocalWsl();
  });

  $("#btn-disconnect").addEventListener("click", async () => {
    await api("/api/disconnect", { method: "POST", body: "{}" });
    currentCwd = "/";
    await refreshStatus();
    renderCommandGrid();
    if ($("#panel-files")?.classList.contains("active")) loadFiles(currentCwd);
    if ($("#panel-monitor")?.classList.contains("active")) refreshMonitor();
    appendOutput({ command: "disconnect", stdout: "已断开连接", stderr: "", exit_code: 0, success: true });
  });

  $("#btn-run-command").addEventListener("click", () => runCommand($("#command-input").value));

  const commandInput = $("#command-input");
  commandInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand(commandInput.value);
      commandInput.value = "";
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!commandHistory.length) return;
      historyIndex = Math.max(0, historyIndex - 1);
      commandInput.value = commandHistory[historyIndex] || "";
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!commandHistory.length) return;
      historyIndex = Math.min(commandHistory.length, historyIndex + 1);
      commandInput.value = commandHistory[historyIndex] || "";
    }
  });

  $("#btn-clear-output").addEventListener("click", () => {
    $("#output").innerHTML = "";
  });

  $("#btn-file-go").addEventListener("click", () => loadFiles($("#file-path").value.trim() || currentCwd));
  $("#btn-file-refresh").addEventListener("click", () => loadFiles($("#file-path").value.trim() || currentCwd));
  $("#btn-file-up").addEventListener("click", () => {
    loadFiles(parentPath($("#file-path").value.trim() || currentCwd));
  });
  $("#file-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadFiles($("#file-path").value.trim() || currentCwd);
    }
  });

  $("#file-upload-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !connected) return;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("path", $("#file-path").value.trim() || currentCwd);
    try {
      const res = await fetch("/api/files/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      renderFileList(data.entries);
      appendOutput({ command: `upload ${file.name}`, stdout: `已上传到 ${data.path}`, stderr: "", exit_code: 0, success: true });
    } catch (err) {
      alert(err.message);
    }
    e.target.value = "";
  });

  $("#btn-refresh-monitor").addEventListener("click", refreshMonitor);

  $("#cmd-search")?.addEventListener("input", renderCommandGrid);

  $$(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  });
}

async function init() {
  initTheme();
  try {
    commandsData = await api("/api/commands");
    activeCategoryId = commandsData.categories[0]?.id || null;
  } catch (err) {
    appendOutput(null, "加载命令配置失败: " + err.message);
  }

  try {
    profiles = JSON.parse(localStorage.getItem("linux-remote-profiles") || "[]");
  } catch {
    profiles = [];
  }

  await refreshStatus();
  await loadWslDefaults();
  await refreshWslHelperStatus();
  renderCommandGrid();
  renderProfiles();
  setupAddButtonDialog();
  setupSaveProfileDialog();
  bindEvents();
}

init();
