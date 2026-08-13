const els = {
  rootPath: document.querySelector("#rootPath"),
  activeBookLabel: document.querySelector("#activeBookLabel"),
  deployBadge: document.querySelector("#deployBadge"),
  jobBadge: document.querySelector("#jobBadge"),
  bookList: document.querySelector("#bookList"),
  bookName: document.querySelector("#bookName"),
  bookKind: document.querySelector("#bookKind"),
  note: document.querySelector("#note"),
  chapter: document.querySelector("#chapter"),
  output: document.querySelector("#output"),
  btnCopyPrompt: document.querySelector("#btnCopyPrompt"),
};

let state = {
  activeBook: "",
  lastPrompt: "",
  pollTimer: null,
};

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "queue";
}

function setOutput(text) {
  els.output.textContent = text;
}

function appendOutput(text) {
  els.output.textContent += text;
  els.output.scrollTop = els.output.scrollHeight;
}

function renderBooks(books, activeBook) {
  els.bookList.innerHTML = "";
  if (!books.length) {
    els.bookList.innerHTML = '<span class="label">还没有书。上面填书名，点「新建书目骨架」。</span>';
    return;
  }
  for (const book of books) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "book-chip" + (book.path === activeBook ? " active" : "");
    btn.textContent = `${book.name} · ${book.kind === "short" ? "短篇" : "长篇"}`;
    btn.addEventListener("click", async () => {
      await api("/api/active-book", { method: "POST", body: JSON.stringify({ book: book.path }) });
      els.bookName.value = book.name;
      await refresh();
    });
    els.bookList.appendChild(btn);
  }
}

async function refresh() {
  const data = await api("/api/status");
  state.activeBook = data.activeBook || "";
  els.rootPath.textContent = data.root;
  els.activeBookLabel.textContent = data.activeBook || "未选择";
  if (data.deploy?.deployed) {
    els.deployBadge.textContent = `已部署 v${data.deploy.setup_skill_version || "?"}`;
    els.deployBadge.className = "badge ok";
  } else {
    els.deployBadge.textContent = "未部署 oh-story";
    els.deployBadge.className = "badge warn";
  }
  renderBooks(data.books || [], data.activeBook);
  const running = (data.jobs || []).find((j) => j.status === "running");
  if (running) {
    els.jobBadge.textContent = `运行中 · ${running.title}`;
    els.jobBadge.className = "badge busy";
  } else {
    els.jobBadge.textContent = "空闲";
    els.jobBadge.className = "badge idle";
  }
  return data;
}

async function scaffold() {
  const book = els.bookName.value.trim();
  if (!book) {
    setOutput("请先填写书名。");
    return;
  }
  const data = await api("/api/scaffold", {
    method: "POST",
    body: JSON.stringify({ book, kind: els.bookKind.value }),
  });
  setOutput(`已创建书目骨架：${data.path}\n已设为当前书。\n接下来可点「开长篇/开短篇」让 Agent 正式开写。`);
  await refresh();
}

async function runAction(action) {
  const body = {
    action,
    mode: selectedMode(),
    book: els.bookName.value.trim() || state.activeBook,
    note: els.note.value.trim(),
    chapter: els.chapter.value.trim(),
  };
  setOutput("提交中…");
  els.btnCopyPrompt.hidden = true;
  const data = await api("/api/run", { method: "POST", body: JSON.stringify(body) });
  state.lastPrompt = data.task?.prompt || "";
  els.btnCopyPrompt.hidden = !state.lastPrompt;

  if (data.mode === "queue") {
    setOutput(
      `${data.hint}\n\n--- 任务提示词 ---\n${data.task.prompt}\n\n任务文件：writing/.console/current-task.md`,
    );
    return;
  }

  setOutput(`已启动 Claude Code 任务 ${data.job.id}（${data.task.title}）\n\n`);
  pollJob(data.job.id);
}

async function pollJob(id) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  let seen = 0;
  state.pollTimer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      const logs = job.log || [];
      while (seen < logs.length) {
        appendOutput(logs[seen].text);
        seen += 1;
      }
      await refresh();
      if (job.status !== "running") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        appendOutput(`\n\n[结束] status=${job.status} exit=${job.exit_code}`);
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      appendOutput(`\n轮询失败：${err.message}`);
    }
  }, 1200);
}

document.querySelector("#btnRefresh").addEventListener("click", () => {
  refresh().catch((err) => setOutput(err.message));
});

document.querySelector("#btnScaffold").addEventListener("click", () => {
  scaffold().catch((err) => setOutput(err.message));
});

document.querySelector("#btnDashboard").addEventListener("click", async () => {
  try {
    const data = await api("/api/dashboard", { method: "POST", body: "{}" });
    setOutput(`文稿台已启动：${data.url}\n（仅本机可访问，用来浏览/编辑正文文件）`);
    window.open(data.url, "_blank");
  } catch (err) {
    setOutput(err.message);
  }
});

document.querySelector("#btnOpenRoot").addEventListener("click", async () => {
  const data = await refresh();
  setOutput(`写作根目录：\n${data.root}\n\n可在资源管理器中打开该路径。`);
});

document.querySelector("#btnCopyPrompt").addEventListener("click", async () => {
  if (!state.lastPrompt) return;
  await navigator.clipboard.writeText(state.lastPrompt);
  appendOutput("\n\n[已复制提示词]");
});

for (const btn of document.querySelectorAll(".action")) {
  btn.addEventListener("click", () => {
    runAction(btn.dataset.action).catch((err) => setOutput(err.message));
  });
}

refresh().catch((err) => setOutput(err.message));
