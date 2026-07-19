const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const targetInput = $("#targetInput");
const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const resultCard = $("#resultCard");
const errorCard = $("#errorCard");
const publicUrl = $("#publicUrl");
const copyBtn = $("#copyBtn");
const targetEcho = $("#targetEcho");
const errorText = $("#errorText");
const logBox = $("#logBox");
const statusText = $("#statusText");
const envBadge = $("#envBadge");
const tipCpolar = $("#tipCpolar");
const providerLockHint = $("#providerLockHint");

const STATUS_LABEL = {
  idle: "空闲",
  starting: "启动中…",
  running: "运行中",
  error: "失败",
  stopped: "已停止",
};

let pollTimer = null;
let appInfo = {};

function selectedProvider() {
  const checked = document.querySelector('input[name="provider"]:checked');
  return checked ? checked.value : "cloudflare";
}

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

function setLoading(loading) {
  startBtn.disabled = loading;
  stopBtn.disabled = loading;
  targetInput.disabled = loading;
}

function setProviderSelection(provider) {
  if (!provider) return;
  const radio = document.querySelector(`input[name="provider"][value="${provider}"]`);
  if (radio) radio.checked = true;
}

function setProviderLocked(locked) {
  $$('input[name="provider"]').forEach((el) => {
    el.disabled = locked;
    el.parentElement.classList.toggle("disabled", locked);
  });
  providerLockHint.classList.toggle("hidden", !locked);
}

function renderStatus(data) {
  const label = STATUS_LABEL[data.status] || data.status;
  statusText.textContent = label;
  statusText.className = `status-pill ${data.status}`;

  if (data.logs?.length) {
    logBox.textContent = data.logs.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (data.provider) {
    setProviderSelection(data.provider);
  }

  if (data.public_url) {
    resultCard.classList.remove("hidden");
    errorCard.classList.add("hidden");
    publicUrl.textContent = data.public_url;
    publicUrl.href = data.public_url;
    const providerLabel = data.provider === "cpolar" ? "cpolar" : "Cloudflare";
    const resolved = data.resolved_addr
      ? ` · 映射到：${data.resolved_addr}`
      : "";
    targetEcho.textContent = data.target
      ? `方式：${providerLabel} · 你填的地址：${data.target}${resolved}`
      : "";
    stopBtn.disabled = false;
    startBtn.disabled = true;
    targetInput.disabled = true;
    setProviderLocked(true);
  } else if (data.status === "error") {
    resultCard.classList.add("hidden");
    errorCard.classList.remove("hidden");
    errorText.textContent = data.error || "隧道启动失败";
    stopBtn.disabled = false;
    startBtn.disabled = false;
    targetInput.disabled = false;
    setProviderLocked(false);
    syncProviderUi();
  } else if (data.status === "starting") {
    stopBtn.disabled = false;
    startBtn.disabled = true;
    targetInput.disabled = true;
    setProviderLocked(true);
  } else if (data.status === "idle" || data.status === "stopped") {
    resultCard.classList.add("hidden");
    if (!data.error) errorCard.classList.add("hidden");
    stopBtn.disabled = true;
    startBtn.disabled = false;
    targetInput.disabled = false;
    setProviderLocked(false);
    syncProviderUi();
  }
}

function syncProviderUi() {
  const provider = selectedProvider();
  tipCpolar.classList.toggle("hidden", provider !== "cpolar");

  const cpolarRadio = document.querySelector('input[name="provider"][value="cpolar"]');
  if (cpolarRadio && !appInfo.cpolar_ready) {
    cpolarRadio.disabled = true;
    cpolarRadio.parentElement.classList.add("disabled");
  } else if (cpolarRadio) {
    cpolarRadio.disabled = false;
    cpolarRadio.parentElement.classList.remove("disabled");
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await api("/api/tunnel/status");
      renderStatus(data);
      if (data.status === "running") {
        setLoading(false);
      }
      if (["running", "error", "stopped", "idle"].includes(data.status)) {
        if (data.status !== "starting") {
          clearInterval(pollTimer);
          pollTimer = null;
          if (data.status !== "running") setLoading(false);
        }
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
      setLoading(false);
    }
  }, 800);
}

async function refreshInfo() {
  try {
    appInfo = await api("/api/info");
    const parts = [];
    if (appInfo.cloudflared) parts.push("Cloudflare");
    if (appInfo.cpolar_ready) parts.push("cpolar");

    if (parts.length) {
      envBadge.textContent = `${parts.join(" + ")} 就绪`;
      envBadge.className = "badge badge-ok";
    } else if (appInfo.cpolar && !appInfo.cpolar_ready) {
      envBadge.textContent = "cpolar 待配置 Token";
      envBadge.className = "badge badge-warn";
    } else {
      envBadge.textContent = "穿透工具未就绪";
      envBadge.className = "badge badge-bad";
    }
    syncProviderUi();
  } catch {
    envBadge.textContent = "服务未连接";
    envBadge.className = "badge badge-bad";
  }
}

async function refreshStatus() {
  const data = await api("/api/tunnel/status");
  renderStatus(data);
  if (data.status === "starting") startPolling();
}

$$('input[name="provider"]').forEach((el) => {
  el.addEventListener("change", syncProviderUi);
});

startBtn.addEventListener("click", async () => {
  const target = targetInput.value.trim();
  const provider = selectedProvider();
  if (!target) {
    errorCard.classList.remove("hidden");
    errorText.textContent = "请输入本地地址";
    return;
  }

  setLoading(true);
  errorCard.classList.add("hidden");
  resultCard.classList.add("hidden");
  logBox.textContent = provider === "cpolar"
    ? "正在启动 cpolar…"
    : "正在启动 cloudflared…";

  startPolling();

  try {
    const data = await api("/api/tunnel/start", {
      method: "POST",
      body: JSON.stringify({ target, provider }),
    });
    if (!data.ok) {
      renderStatus({ ...data, status: "error" });
      setLoading(false);
      return;
    }
    renderStatus(data);
  } catch (err) {
    errorCard.classList.remove("hidden");
    errorText.textContent = err.message;
    setLoading(false);
  }
});

stopBtn.addEventListener("click", async () => {
  setLoading(true);
  try {
    await api("/api/tunnel/stop", { method: "POST" });
    await refreshStatus();
  } finally {
    setLoading(false);
  }
});

copyBtn.addEventListener("click", async () => {
  const text = publicUrl.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "已复制";
    setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
  } catch {
    copyBtn.textContent = "复制失败";
  }
});

targetInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !startBtn.disabled) startBtn.click();
});

refreshInfo();
refreshStatus();
