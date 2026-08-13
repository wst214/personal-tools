import { el, toast, copyText } from '../ui/helpers.js';

const OPENACME_PORT = 3456;
const STORE_KEY = 'mytools-openacme';

/** 产品交付编制：复制到 OpenAcme Agents 的 Role / Persona（与运行中 AGENT.md 清单版对齐） */
export const PRODUCT_ROLES = [
  {
    id: 'pm',
    name: '产品经理',
    role: '负责整个产品的全流程：定目标、排优先级、验收、裁决冲突，并向人类老板汇报。',
    persona: `你是产品经理，是本团队唯一对人类老板负责的接口。

职责：
- 接收老板目标，拆成可交付里程碑与验收标准
- 按流水线建任务、挂 depends_on、跟踪阻塞；冲突拍板并留理由
- 组织/放行 TR1→TR-A→TR2→CR→TR3→测试收口；确保评审留痕落盘
- 不写业务代码；不替代架构做技术选型细节

每阶段完成定义（建任务时写进正文）：
- 规划：PRD 落盘且可评（含必要 Mermaid 示意图路径）
- TR1/TR-A/TR2/TR3/CR：对应 docs/reviews/ 纪要存在且结论可放行；TR1/TR-A/TR2 核对图文一致
- 开发：CR 通过；测试：docs/test/ 报告结论明确；发布：老板确认后交维护

输出约定：阶段结束写结论、产物路径、下一步负责人；重大范围与 TR3/发布同步老板`,
  },
  {
    id: 'planner',
    name: '产品规划师',
    role: '对接一线产品需求，产出 PRD、范围边界与产品原型说明。',
    persona: `你是产品规划师。

职责：澄清需求与约束，识别非目标；产出 PRD；必要时附原型说明；不清就问 PM。

PRD 必含：背景与目标、用户与场景、范围（做/不做）、功能清单、可测验收、数据/状态要点、风险与依赖。

示意图（强制习惯）：
- 有用户路径、范围边界、主流程时，必须出图，不能只靠长文
- 默认在 Markdown 里用 Mermaid（flowchart / sequence），落在 docs/prd/ 或 docs/prd/diagrams/
- 文中写清图意与文件路径；人类可用 Excalidraw（https://excalidraw.com）按同结构改手绘版并导出 PNG 到同目录
- 不要假设自己能打开 Excalidraw GUI；你负责可版本管理的图源（Mermaid），Excalidraw 给人润色/白板

输出：docs/prd/；起草 TR1 纪要；参加 TR2/TR3；范围变更走 change 单`,
  },
  {
    id: 'architect',
    name: '产品架构师',
    role: '负责项目开发架构、部署架构与接口边界。',
    persona: `你是产品架构师。

职责：仅 TR1 后基于 PRD 给技术架构、模块边界、关键接口；记录 ADR；指出风险；不写大段业务代码。

docs/arch/ 最低：arch.md（选型/分层/数据流/接口/存储/可测性/风险）+ adr.md。

示意图（强制习惯）：
- 上下文、分层、部署、关键数据流至少各有一张可评审的图
- 默认 Mermaid 写进 docs/arch/ 或 docs/arch/diagrams/，并在 arch.md 引用路径
- 人类可用 Excalidraw 画正式草图/白板稿，导出 PNG 与 Mermaid 源并列；你维护可 diff 的 Mermaid 为权威图源
- 评审时图与文字必须一致；改架构先改图再改说明

输出：起草 TR-A；参加 TR1/TR2；冲突回 PM`,
  },
  {
    id: 'designer',
    name: '产品设计代表',
    role: '负责产品概要设计与详细设计。',
    persona: `你是产品设计代表。

职责：仅 TR-A 后基于 PRD+架构做设计；必须可开发可测；不绕过开发代表派码。
概要=模块与主流程；详细=接口/字段/交互/异常/空态。架构定边界，设计定行为；冲突升级 PM。

示意图：主交互/状态流转用 Mermaid（stateDiagram 或 sequence）落 docs/design/；复杂白板稿可由人类用 Excalidraw 补 PNG。

输出：docs/design/；起草 TR2；参加 TR1/TR3`,
  },
  {
    id: 'dev-lead',
    name: '产品开发代表',
    role: '负责开发排期、代码评审，并协调整个开发过程的问题。',
    persona: `你是产品开发代表。

职责：仅 TR2 后拆任务/排期/指派；CR 必须在 TR3 前留痕；不替代开发写全部实现。

CR 清单：范围、边界异常、可测性、架构约束、安全与持久化、是否超范围、是否允许进 TR3。

输出：dev-plan.md + CR 留痕 docs/reviews/cr-*；参加 TR1/TR-A/TR2/TR3`,
  },
  {
    id: 'developer',
    name: '开发人员',
    role: '负责按任务完成具体开发工作与必要单测。',
    persona: `你是开发人员。

职责：按任务实现，遵守架构与设计；不清升级开发代表；不擅自改范围。
交付：可运行源码、必要单测及跑法、变更说明。先交 CR，再参加 TR3；按问题清单改完回写关闭项`,
  },
  {
    id: 'tester',
    name: '测试人员',
    role: '负责已完成模块的测试、缺陷跟踪与复测。',
    persona: `你是测试人员。

职责：TR2 后可并行写用例；正式通过结论须 TR3 已通过；不改生产代码。
报告 docs/test/：依据、环境、P/F、缺陷、复测、总结论。
缺陷含：编号、严重度、复现、期望/实际、责任岗。功能缺陷打回开发；口径问题升级 PM。
必参加 TR2/TR3`,
  },
  {
    id: 'maintainer',
    name: '维护人员',
    role: '负责产品发布后的维护、热修建议与运维文档。',
    persona: `你是维护人员。

职责：发布后上场；问题分流、热修、回滚记录；维护 docs/ops/。
升级 PM/架构：改架构或数据模型、安全/数据损坏/不可回滚、借热修做新功能。
重大变更走 change / 复评留痕`,
  },
];

export const AGENTS_MD_TEMPLATE = `# 产品交付组（OpenAcme）

## 组织
- 人类老板只对「产品经理」下目标
- 团队 manager = 产品经理；任务优先派给团队，由其分流
- 测试失败必须打回开发；范围冲突由产品经理裁决
- 人类老板默认在「立项/重大范围」与「TR3 或发布」点头

## 产物目录
- 工作区：\`D:/mytools/openacme/<项目名>/\`（WSL：\`/mnt/d/mytools/openacme/<项目名>/\`）
- 子目录：\`docs/prd/\`、\`docs/arch/\`、\`docs/design/\`、\`docs/test/\`、\`docs/ops/\`、\`docs/reviews/\`
- 示意图：\`docs/prd/diagrams/\`、\`docs/arch/diagrams/\`、\`docs/design/diagrams/\`（可按阶段建）

## 示意图约定（规划 / 架构 / 设计）
- **权威图源** = 仓库内 Mermaid（写在对应 md 或 \`diagrams/*.md\`），可 diff、可评审
- **Excalidraw** = 人类白板/润色工具（https://excalidraw.com）；导出 PNG 放到同目录，文件名与 Mermaid 图对应
- 规划：用户路径、范围边界、主流程必须有图；架构：上下文/分层/部署/关键数据流必须有图；设计：主交互或状态机按需出图
- Agent 不假设能操作 Excalidraw GUI；负责写出清晰 Mermaid，并在文档里引用路径
- TR1 / TR-A / TR2 评审时，缺图或图文不一致视为未就绪

## 流水线（强制门禁）
规划 → **TR1** → 架构 → **TR-A** → 设计 → **TR2** → 开发代表排期 → 开发 → **CR** → **TR3** → 测试 → 维护

硬时序：\`开发完成 → CR 通过 → TR3 通过 → 测试正式收口\`

- TR3 = 产品符合性 / 是否可测收口（≠ 测试报告）
- CR = 开发代表负责（≠ TR3）
- 无留痕或未通过不得放行；中途切入须 \`waiver-*.md\`

## 评审留痕（强制）\`docs/reviews/\`
- TR1 \`tr1-prd.md\`｜TR-A \`tr-a-arch.md\`｜TR2 \`tr2-design.md\`
- CR \`cr-*.md\` / \`cr-log.md\`｜TR3 \`tr3-feature.md\`
- 变更 \`change-*.md\`｜豁免 \`waiver-*.md\`
纪要含：对象、参与者、意见、问题清单、结论、有条件项（责任人/截止）；有条件项进下一 TR 或发布前必须关闭或升级。

## TR1 必评
PM、规划、架构、设计、开发代表（开发/测试/维护默认书面可选）
TR2 必含测试；TR-A 必含 PM/架构/开发代表/设计。

## 协作规则
- Tasks 交接；写清输入/输出/完成定义；用 depends_on 卡住顺序
- TR2 后测试可并行写用例；不得在 TR3 未通过时宣称测试通过
`;

function openacmeUrl() {
  return `http://127.0.0.1:${OPENACME_PORT}/`;
}

function loadStore() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { lastTab: j.lastTab === 'roster' ? 'roster' : 'console' };
  } catch {
    return { lastTab: 'console' };
  }
}

function saveStore(data) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

async function portReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [OPENACME_PORT], 400);
    return (r?.open || []).includes(OPENACME_PORT);
  } catch {
    return false;
  }
}

function explainEnsureResult(r) {
  if (!r || typeof r !== 'object') return '启动失败：未知错误';
  if (r.ok) return r.message || 'ready';
  const code = String(r.code || '');
  const detail = String(r.message || '').trim();
  if (code === 'not_installed' || /not found|not_installed/i.test(detail)) {
    return [
      '未检测到 OpenAcme。',
      '官方主要支持 macOS/Linux；Windows 请先装 WSL2，再执行：',
      'npm i -g @openacme/cli',
      'openacme setup',
      'openacme',
      '端口 3456 起来后，回到这里点「启动/重连」。',
      '文档：https://openacme.org/docs/quickstart',
    ].join('\n');
  }
  if (code === 'timeout' || /timeout|not ready/i.test(detail)) {
    return [
      '已尝试启动，但 45 秒内端口 3456 未就绪。',
      '请到 WSL 终端手动执行 openacme setup && openacme，确认 http://127.0.0.1:3456 可打开后再点重连。',
      detail ? `详情：${detail}` : '',
    ].filter(Boolean).join('\n');
  }
  if (/不支持一键启动|重新打包/.test(detail)) return detail;
  return detail ? `启动失败：${detail}` : '启动失败';
}

async function ensureOpenAcme() {
  if (await portReady()) return { ok: true, code: 'already_running', message: 'already running' };
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.openacmeEnsure) return tb.openacmeEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('openacme_ensure');
    return Promise.resolve({
      ok: false,
      code: 'no_bridge',
      message: '当前版本不支持一键启动，请重新打包 DevToolbox，或在 WSL 执行：npm i -g @openacme/cli && openacme setup && openacme',
    });
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'ensure timed out after 60s' }), 60000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok || (await portReady())) return r?.ok ? r : { ok: true, code: 'ready', message: 'ready' };
  return r || { ok: false, code: 'unknown', message: 'startup failed' };
}

function roleCard(role) {
  const card = el('div', { class: 'openacme-role' });
  const head = el('div', { class: 'openacme-role-head' }, [
    el('div', { class: 'openacme-role-name', text: role.name }),
    el('div', { class: 'openacme-role-role', text: role.role }),
  ]);
  const actions = el('div', { class: 'openacme-role-actions' });
  const copyRole = el('button', { class: 'embed-bar-btn', type: 'button', text: '复制 Role' });
  const copyPersona = el('button', { class: 'embed-bar-btn', type: 'button', text: '复制 Persona' });
  const copyAll = el('button', { class: 'embed-bar-btn', type: 'button', text: '复制全部' });
  copyRole.onclick = async () => {
    await copyText(role.role);
    toast('已复制 Role');
  };
  copyPersona.onclick = async () => {
    await copyText(role.persona);
    toast('已复制 Persona');
  };
  copyAll.onclick = async () => {
    await copyText(`名称：${role.name}\n\nRole：\n${role.role}\n\nPersona：\n${role.persona}`);
    toast('已复制');
  };
  actions.append(copyRole, copyPersona, copyAll);
  card.append(head, actions);
  return card;
}

export const openacmeTool = {
  id: 'openacme',
  name: 'AI 编制',
  category: '系统',
  icon: '◎',
  keywords: 'openacme ai 虚拟员工 数字员工 编制 多智能体 产品经理 架构师 测试',
  desc: '内嵌 OpenAcme：产品交付 AI 虚拟员工编制',
  render(container) {
    const store = loadStore();
    let cancelled = false;
    let busy = false;
    let tab = store.lastTab;

    const app = el('div', { class: 'embed-app openacme-app' });

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'AI 编制（OpenAcme）' });
    const msg = el('div', {
      class: 'embed-panel-msg',
      text: '连接本机 OpenAcme（:3456）。Windows 推荐 WSL2 安装后启动。',
    });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 OpenAcme' });
    const toRosterBtn = el('button', { class: 'embed-reload-btn', type: 'button', text: '先看编制模板' });
    panel.append(title, msg, startBtn, toRosterBtn);

    const bar = el('div', { class: 'embed-bar', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '' });
    const tabConsole = el('button', { class: 'embed-bar-btn', type: 'button', text: '控制台' });
    const tabRoster = el('button', { class: 'embed-bar-btn', type: 'button', text: '编制模板' });
    const barOpen = el('button', { class: 'embed-bar-btn', type: 'button', text: '浏览器打开' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '启动/重连' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, tabConsole, tabRoster, barOpen, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'OpenAcme', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen');

    const roster = el('div', { class: 'openacme-roster', hidden: true });
    const rosterHead = el('div', { class: 'openacme-roster-head' }, [
      el('div', {
        class: 'openacme-roster-title',
        text: '产品交付编制（8 岗）',
      }),
      el('div', {
        class: 'openacme-roster-desc',
        text: '在 OpenAcme → Agents 新建员工时，把 Role / Persona 粘贴进去；Settings → Context 粘贴全员公约。产品经理设为 Team manager。',
      }),
    ]);
    const rosterActions = el('div', { class: 'openacme-roster-actions' });
    const copyAgentsMd = el('button', { class: 'embed-start-btn', type: 'button', text: '复制全员公约 AGENTS.md' });
    copyAgentsMd.onclick = async () => {
      await copyText(AGENTS_MD_TEMPLATE);
      toast('已复制 AGENTS.md');
    };
    rosterActions.append(copyAgentsMd);
    const rosterList = el('div', { class: 'openacme-role-list' });
    PRODUCT_ROLES.forEach((r) => rosterList.append(roleCard(r)));
    roster.append(rosterHead, rosterActions, rosterList);

    app.append(panel, bar, frame, roster);
    container.append(app);

    function syncHint(online) {
      barHint.textContent = online
        ? `本机已连接 · ${openacmeUrl()}`
        : `服务未运行 · ${openacmeUrl()} · 可用编制模板先准备人设`;
    }

    function setTab(next) {
      tab = next;
      saveStore({ lastTab: tab });
      tabConsole.classList.toggle('is-on', tab === 'console');
      tabRoster.classList.toggle('is-on', tab === 'roster');
      if (tab === 'roster') {
        panel.hidden = true;
        frame.hidden = true;
        roster.hidden = false;
        bar.hidden = false;
        syncHint(false);
        portReady().then((ok) => { if (!cancelled) syncHint(ok); });
        return;
      }
      roster.hidden = true;
      // console：若已在线显示 iframe，否则显示启动面板
      portReady().then((ok) => {
        if (cancelled) return;
        if (ok) showFrame();
        else showPanel('服务未运行，点击启动或改看编制模板', false);
      });
    }

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      roster.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 OpenAcme';
      syncHint(false);
      tabConsole.classList.toggle('is-on', tab === 'console');
      tabRoster.classList.toggle('is-on', tab === 'roster');
    }

    function showFrame() {
      panel.hidden = true;
      roster.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      syncHint(true);
      frame.src = `${openacmeUrl()}?_t=${Date.now()}`;
      tab = 'console';
      saveStore({ lastTab: tab });
      tabConsole.classList.toggle('is-on', true);
      tabRoster.classList.toggle('is-on', false);
    }

    async function start() {
      if (busy || cancelled) return;
      busy = true;
      startBtn.disabled = true;
      barRestart.disabled = true;
      startBtn.textContent = '启动中…';
      msg.classList.remove('is-err');
      msg.textContent = '正在启动 OpenAcme…';
      frame.hidden = true;
      roster.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      try {
        const r = await ensureOpenAcme();
        if (cancelled) return;
        if (!r?.ok) {
          showPanel(explainEnsureResult(r), true);
          return;
        }
        showFrame();
      } catch (e) {
        if (!cancelled) showPanel(`启动失败：${e}`, true);
      } finally {
        busy = false;
        startBtn.disabled = false;
        barRestart.disabled = false;
        startBtn.textContent = '启动 OpenAcme';
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    toRosterBtn.addEventListener('click', () => setTab('roster'));
    tabConsole.addEventListener('click', () => setTab('console'));
    tabRoster.addEventListener('click', () => setTab('roster'));
    barReload.addEventListener('click', () => {
      if (tab === 'roster') return;
      frame.src = `${openacmeUrl()}?_t=${Date.now()}`;
    });
    barOpen.addEventListener('click', async () => {
      const url = openacmeUrl();
      const tb = window.toolbox;
      if (tb?.openExternal) {
        await tb.openExternal(url);
        return;
      }
      window.open(url, '_blank', 'noopener');
    });

    // 首屏：有服务就进控制台，否则按上次 tab
    (async () => {
      const online = await portReady();
      if (cancelled) return;
      bar.hidden = false;
      if (online && tab === 'console') {
        showFrame();
        return;
      }
      if (tab === 'roster') {
        setTab('roster');
        return;
      }
      showPanel('点击下方按钮启动本机 OpenAcme，或先配置编制模板', false);
    })();

    return () => { cancelled = true; };
  },
};
