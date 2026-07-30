const $ = (selector) => document.querySelector(selector);

const form = $("#environmentForm");
const environmentSelect = $("#environmentSelect");
const serviceEditorList = $("#serviceEditorList");
const serviceEditorTemplate = $("#serviceEditorTemplate");
const serviceList = $("#serviceList");
const stepList = $("#stepList");
const taskSteps = $("#taskSteps");
const logBox = $("#logBox");
const taskStatus = $("#taskStatus");
const runtimeBadge = $("#runtimeBadge");

const STEP_OPTIONS = [
  ["preflight", "环境检查", "校验本机 Docker、SSH、远端 Compose 和配置差异", true],
  ["build", "构建镜像", "慢步骤；需要重新生成 jar / 镜像时再勾选", false],
  ["package_upload", "上传镜像包", "默认直接上传 exports 中已有 tar，不跑 Maven", true],
  ["sync_config", "同步 Compose / .env", "默认不传；仅在配置确实变化时勾选", false],
  ["load", "加载镜像", "远端 docker load", true],
  ["migration", "执行 db-migration", "默认不执行；有迁移变更时再勾选", false],
  ["restart", "重启业务服务", "仅更新选中的常驻服务", true],
  ["verify", "验证服务", "检查容器和健康检查 URL", true],
];

const STATUS_LABEL = { pending: "等待", running: "执行中", done: "成功", error: "失败", skipped: "跳过", idle: "空闲" };
const FIXED_DEFAULTS = {
  local_image_dir: "exports",
  local_compose_file: "deployments/docker-compose/docker-compose.yml",
  local_env_file: "deployments/docker-compose/.env",
  remote_deploy_root: "/opt/leidian/deploy",
  remote_image_dir: "/opt/leidian/deploy/images",
  remote_compose_file: "compose/s3/docker-compose.yml",
  remote_env_file: "compose/s3/.env",
};
let environments = [];
let currentEnvironment = null;
let activeTaskId = null;
let pollingTimer = null;
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function value(id) { return $(id).value.trim(); }
function setValue(id, next) { $(id).value = next || ""; }
function checkbox(id) { return $(id).checked; }
function escapeHtml(input) { return String(input).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function setBusy(next) {
  busy = next;
  document.querySelectorAll("button, select, input").forEach((element) => {
    if (element.id === "logBox") return;
    element.disabled = next;
  });
}

function renderRuntime(info) {
  const ready = info.docker_available && info.paramiko_available;
  runtimeBadge.className = `badge ${ready ? "badge-ok" : "badge-error"}`;
  runtimeBadge.textContent = ready ? `本机依赖就绪 · ${info.environment_count} 个环境` : "缺少 Docker CLI 或 Paramiko";
}

function createServiceEditor(service = {}) {
  const row = serviceEditorTemplate.content.firstElementChild.cloneNode(true);
  Object.entries(service).forEach(([field, fieldValue]) => {
    const input = row.querySelector(`[data-field="${field}"]`);
    if (!input) return;
    if (input.type === "checkbox") input.checked = Boolean(fieldValue);
    else input.value = fieldValue || "";
  });
  row.querySelector("[data-remove-service]").addEventListener("click", () => row.remove());
  serviceEditorList.appendChild(row);
}

function collectServices() {
  return [...serviceEditorList.querySelectorAll(".service-editor-row")]
    .map((row) => ({
      name: row.querySelector('[data-field="name"]').value.trim(),
      label: row.querySelector('[data-field="label"]').value.trim(),
      image: row.querySelector('[data-field="image"]').value.trim(),
      maven_module: row.querySelector('[data-field="maven_module"]').value.trim(),
      health_url: row.querySelector('[data-field="health_url"]').value.trim(),
      default_selected: row.querySelector('[data-field="default_selected"]').checked,
      restart: row.querySelector('[data-field="restart"]').checked,
    }))
    .filter((service) => service.name);
}

function environmentPayload() {
  return {
    id: value("#environmentId"),
    name: value("#environmentName"),
    host: value("#host"),
    port: Number(value("#port") || 22),
    username: value("#username"),
    auth_method: value("#authMethod"),
    password: value("#password"),
    private_key_path: value("#privateKeyPath"),
    private_key_passphrase: value("#privateKeyPassphrase"),
    use_sudo: checkbox("#useSudo"),
    sudo_password: value("#sudoPassword"),
    project_path: value("#projectPath"),
    local_image_dir: value("#localImageDir") || FIXED_DEFAULTS.local_image_dir,
    local_compose_file: value("#localComposeFile") || FIXED_DEFAULTS.local_compose_file,
    local_env_file: value("#localEnvFile") || FIXED_DEFAULTS.local_env_file,
    remote_deploy_root: value("#remoteDeployRoot") || FIXED_DEFAULTS.remote_deploy_root,
    remote_image_dir: value("#remoteImageDir") || FIXED_DEFAULTS.remote_image_dir,
    remote_compose_file: value("#remoteComposeFile") || FIXED_DEFAULTS.remote_compose_file,
    remote_env_file: value("#remoteEnvFile") || FIXED_DEFAULTS.remote_env_file,
    services: collectServices(),
  };
}

function setSecretHint(id, configured) {
  const element = $(id);
  if (!element) return;
  element.textContent = configured ? "（已保存，留空不覆盖）" : "";
}

function renderEnvironment(environment) {
  currentEnvironment = environment;
  setValue("#environmentId", environment.id);
  setValue("#environmentName", environment.name);
  setValue("#host", environment.host);
  setValue("#port", environment.port || 22);
  setValue("#username", environment.username);
  setValue("#authMethod", environment.auth_method === "key" ? "password" : environment.auth_method || "password");
  setValue("#password", "");
  setValue("#privateKeyPath", environment.private_key_path);
  setValue("#privateKeyPassphrase", "");
  $("#useSudo").checked = Boolean(environment.use_sudo);
  setValue("#sudoPassword", "");
  setValue("#projectPath", environment.project_path);
  setValue("#localImageDir", environment.local_image_dir || FIXED_DEFAULTS.local_image_dir);
  setValue("#localComposeFile", environment.local_compose_file || FIXED_DEFAULTS.local_compose_file);
  setValue("#localEnvFile", environment.local_env_file || FIXED_DEFAULTS.local_env_file);
  setValue("#remoteDeployRoot", environment.remote_deploy_root || FIXED_DEFAULTS.remote_deploy_root);
  setValue("#remoteImageDir", environment.remote_image_dir || FIXED_DEFAULTS.remote_image_dir);
  setValue("#remoteComposeFile", environment.remote_compose_file || FIXED_DEFAULTS.remote_compose_file);
  setValue("#remoteEnvFile", environment.remote_env_file || FIXED_DEFAULTS.remote_env_file);
  setSecretHint("#passwordHint", environment.password_configured);
  setSecretHint("#sudoHint", environment.sudo_password_configured);
  serviceEditorList.innerHTML = "";
  (environment.services || []).forEach(createServiceEditor);
  renderDeploymentChoices(environment);
}

function renderEnvironmentSelect(selectedId) {
  environmentSelect.innerHTML = environments.map((environment) => `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)}</option>`).join("");
  environmentSelect.value = selectedId || environments[0]?.id || "";
}

function renderDeploymentChoices(environment) {
  serviceList.innerHTML = (environment.services || []).map((service) => `
    <label class="choice-card service-choice">
      <input type="checkbox" data-service="${escapeHtml(service.name)}" ${service.default_selected ? "checked" : ""} />
      <span><strong>${escapeHtml(service.label)}</strong><small>${escapeHtml(service.image || service.name)} · ${escapeHtml(service.archive_file || "")}</small></span>
      ${service.restart ? "<em>常驻</em>" : "<em>任务</em>"}
    </label>`).join("");
  stepList.innerHTML = STEP_OPTIONS.map(([id, label, description, checked], index) => `
    <label class="choice-card step-choice">
      <input type="checkbox" data-step="${id}" ${checked ? "checked" : ""} />
      <span class="step-number">${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${label}</strong><small>${description}</small></span>
    </label>`).join("");
  document.querySelectorAll("[data-service], [data-step]").forEach((input) => input.addEventListener("change", updateSelectionSummary));
  updateSelectionSummary();
}

function selectedServices() { return [...document.querySelectorAll("[data-service]:checked")].map((input) => input.dataset.service); }
function selectedSteps() { return [...document.querySelectorAll("[data-step]:checked")].map((input) => input.dataset.step); }

function updateSelectionSummary() {
  const serviceCount = selectedServices().length;
  const stepCount = selectedSteps().length;
  $("#selectionSummary").textContent = `${serviceCount} 个服务 · ${stepCount} 个步骤`;
}

async function loadEnvironments(selectId) {
  const data = await api("/api/environments");
  environments = data.environments;
  const nextId = selectId || environmentSelect.value || environments[0]?.id;
  renderEnvironmentSelect(nextId);
  const environment = environments.find((item) => item.id === nextId) || environments[0];
  if (environment) renderEnvironment(environment);
}

async function saveEnvironment(showMessage = true) {
  const payload = environmentPayload();
  if (!payload.name || !payload.host || !payload.username || !payload.project_path) throw new Error("请填写环境名称、服务器地址、SSH 用户和本地项目目录");
  if (!payload.services.length) throw new Error("至少保留一个服务配置");
  const data = await api("/api/environments", { method: "POST", body: JSON.stringify(payload) });
  await loadEnvironments(data.environment.id);
  if (showMessage) {
    logBox.textContent = "环境配置已保存在本机（敏感字段已隐藏）。";
  }
  return data.environment;
}

function renderTask(task) {
  taskStatus.textContent = STATUS_LABEL[task.status] || task.status;
  taskStatus.className = `status-pill ${task.status}`;
  taskSteps.innerHTML = task.steps.map((step) => `
    <article class="task-step ${step.status}">
      <span class="step-state">${STATUS_LABEL[step.status] || step.status}</span>
      <div><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.description)}</small></div>
    </article>`).join("");
  const logs = task.steps.flatMap((step) => step.logs.length ? [`\n### ${step.label}`, ...step.logs] : []);
  logBox.textContent = logs.join("\n").trim() || "任务已创建，等待执行…";
  logBox.scrollTop = logBox.scrollHeight;
}

function pollTask() {
  if (pollingTimer) return;
  pollingTimer = setInterval(async () => {
    if (!activeTaskId) return;
    try {
      const task = await api(`/api/tasks/${activeTaskId}`);
      renderTask(task);
      if (task.status !== "running") {
        clearInterval(pollingTimer);
        pollingTimer = null;
        activeTaskId = null;
        setBusy(false);
      }
    } catch (error) {
      clearInterval(pollingTimer);
      pollingTimer = null;
      activeTaskId = null;
      setBusy(false);
      logBox.textContent += `\n[获取任务失败] ${error.message}`;
    }
  }, 800);
}

async function startDeployment(steps) {
  if (busy) return;
  try {
    setBusy(true);
    const services = selectedServices();
    if (!services.length) throw new Error("请至少选择一个服务");
    const environment = await saveEnvironment(false);
    const data = await api("/api/deployments", { method: "POST", body: JSON.stringify({ environment_id: environment.id, services, steps }) });
    activeTaskId = data.task.id;
    renderTask(data.task);
    pollTask();
  } catch (error) {
    setBusy(false);
    taskStatus.textContent = "失败";
    taskStatus.className = "status-pill error";
    logBox.textContent = `[错误] ${error.message}`;
  }
}

function newEnvironment() {
  currentEnvironment = null;
  form.reset();
  setValue("#environmentId", "");
  setValue("#port", "22");
  setValue("#projectPath", "D:\\workspace\\leidian\\leidan-pgsql");
  setValue("#localImageDir", FIXED_DEFAULTS.local_image_dir);
  setValue("#localComposeFile", FIXED_DEFAULTS.local_compose_file);
  setValue("#localEnvFile", FIXED_DEFAULTS.local_env_file);
  setValue("#remoteDeployRoot", FIXED_DEFAULTS.remote_deploy_root);
  setValue("#remoteImageDir", FIXED_DEFAULTS.remote_image_dir);
  setValue("#remoteComposeFile", FIXED_DEFAULTS.remote_compose_file);
  setValue("#remoteEnvFile", FIXED_DEFAULTS.remote_env_file);
  serviceEditorList.innerHTML = "";
  createServiceEditor();
  serviceList.innerHTML = "<p class='empty-state'>填写服务清单并保存后，即可选择更新服务。</p>";
  stepList.innerHTML = "";
}

function bindEvents() {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await saveEnvironment(); } catch (error) { logBox.textContent = `[错误] ${error.message}`; }
  });
  environmentSelect.addEventListener("change", () => {
    const environment = environments.find((item) => item.id === environmentSelect.value);
    if (environment) renderEnvironment(environment);
  });
  $("#newEnvironment").addEventListener("click", newEnvironment);
  $("#addService").addEventListener("click", () => createServiceEditor());
  $("#toggleAllServices").addEventListener("click", () => {
    const inputs = [...document.querySelectorAll("[data-service]")];
    const allChecked = inputs.length && inputs.every((input) => input.checked);
    inputs.forEach((input) => { input.checked = !allChecked; });
    $("#toggleAllServices").textContent = allChecked ? "全选" : "取消全选";
    updateSelectionSummary();
  });
  $("#runPreflight").addEventListener("click", () => startDeployment(["preflight"]));
  $("#startDeployment").addEventListener("click", () => startDeployment(selectedSteps()));
  $("#deleteEnvironment").addEventListener("click", async () => {
    if (!currentEnvironment || !confirm(`删除环境“${currentEnvironment.name}”？`)) return;
    try { await api(`/api/environments/${currentEnvironment.id}`, { method: "DELETE" }); await loadEnvironments(); } catch (error) { logBox.textContent = `[错误] ${error.message}`; }
  });
}

async function boot() {
  bindEvents();
  try {
    renderRuntime(await api("/api/info"));
    await loadEnvironments();
  } catch (error) {
    runtimeBadge.className = "badge badge-error";
    runtimeBadge.textContent = "面板初始化失败";
    logBox.textContent = `[错误] ${error.message}`;
  }
}

boot();
