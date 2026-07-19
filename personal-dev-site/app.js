(function () {
  const timeLabel = document.querySelector("[data-current-time]");
  const dateLabel = document.querySelector("[data-date-label]");
  const greetingLabel = document.querySelector("[data-greeting]");
  const dailyMessage = document.querySelector("[data-daily-message]");
  const menuButton = document.querySelector("[data-menu-button]");
  const scrim = document.querySelector("[data-scrim]");
  const serviceCards = Array.from(document.querySelectorAll("[data-service-card]"));
  const onlineCount = document.querySelector("[data-online-count]");

  const periods = [
    {
      key: "late-night",
      start: 0,
      greeting: "夜深了，",
      messages: [
        "慢一点，也是在向前。",
        "把最后一点思绪安放好。",
        "留一点安静给未完成的事。",
        "今晚适合把线索慢慢理清。",
        "做完手边这件，就好好休息。",
        "安静的时候，答案更容易出现。",
      ],
    },
    {
      key: "morning",
      start: 5,
      greeting: "早上好，",
      messages: [
        "今天也把复杂的事变简单。",
        "先走稳今天的第一步。",
        "从一件值得完成的小事开始。",
        "把清醒留给真正重要的事。",
        "今天也做一点扎实的进展。",
        "理清重点，然后轻松出发。",
      ],
    },
    {
      key: "noon",
      start: 11,
      greeting: "中午好，",
      messages: [
        "上午辛苦了，先整理一下节奏。",
        "停一下，再带着重点继续。",
        "给思路一点呼吸的空间。",
        "吃好午饭，也照顾好专注力。",
        "半日已过，继续从容推进。",
        "重新排好优先级，再出发。",
      ],
    },
    {
      key: "afternoon",
      start: 14,
      greeting: "下午好，",
      messages: [
        "把今天最重要的事推进一点。",
        "保持节奏，答案正在靠近。",
        "现在适合解决那个关键问题。",
        "把零散想法收束成结果。",
        "专注一会儿，事情会慢慢清晰。",
        "继续做有积累的那件事。",
      ],
    },
    {
      key: "evening",
      start: 18,
      greeting: "晚上好，",
      messages: [
        "给今天一个舒服的收尾。",
        "看看今天留下些什么。",
        "收好进度，也留一点余地。",
        "把未完成的事安顿妥当。",
        "今天的积累，已经算数。",
        "放慢节奏，整理今天的成果。",
      ],
    },
  ];

  function hashText(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash;
  }

  function updateGreeting(now) {
    const hour = now.getHours();
    const period = [...periods].reverse().find((item) => hour >= item.start) || periods[0];
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const messageIndex = hashText(`${dateKey}-${period.key}`) % period.messages.length;
    greetingLabel.textContent = period.greeting;
    dailyMessage.textContent = period.messages[messageIndex];
  }

  function updateClock() {
    const now = new Date();
    timeLabel.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const parts = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    dateLabel.textContent = `${values.year}.${values.month}.${values.day}`;
    updateGreeting(now);
  }

  function serviceUrl(card) {
    const host = window.location.hostname || "127.0.0.1";
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    const path = card.dataset.path || "/";
    return `${protocol}//${host}:${card.dataset.port}${path}`;
  }

  async function checkService(card) {
    const state = card.querySelector("[data-service-state]");
    const target = serviceUrl(card);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2200);

    card.href = target;
    state.classList.remove("checking", "online", "offline");

    try {
      await fetch(target, { mode: "no-cors", cache: "no-store", signal: controller.signal });
      state.classList.add("online");
      state.innerHTML = "<i></i>在线";
      return true;
    } catch (_error) {
      state.classList.add("offline");
      state.innerHTML = "<i></i>离线";
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function checkServices() {
    const results = await Promise.all(serviceCards.map(checkService));
    onlineCount.textContent = String(results.filter(Boolean).length);
  }

  function closeMenu() { document.body.classList.remove("menu-open"); }
  menuButton.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  scrim.addEventListener("click", closeMenu);
  document.querySelectorAll(".side-nav a").forEach((link) => link.addEventListener("click", closeMenu));
  updateClock();
  checkServices();
  window.setInterval(updateClock, 30000);
  window.setInterval(checkServices, 30000);
})();
