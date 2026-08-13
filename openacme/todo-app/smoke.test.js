// smoke.test.js — 交互层冒烟测试（无需浏览器，用极简 DOM shim 驱动 app.js）
// 运行：node --test smoke.test.js
// 覆盖 US1（新增）/ US1a（空标题）/ US2（编辑）/ US3（删除）/ US4（勾选）/ US5（持久化）/ US6（展示）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ---- 极简 DOM shim ----
class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...c) {
    c.forEach((x) => this.set.add(x));
  }
  remove(...c) {
    c.forEach((x) => this.set.delete(x));
  }
  contains(c) {
    return this.set.has(c);
  }
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList(this);
    this.listeners = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this._className = "";
    this._textContent = "";
  }
  get className() {
    return this._className;
  }
  set className(v) {
    this._className = v;
    this.classList.set = new Set(v.split(/\s+/).filter(Boolean));
  }
  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = v;
    if (v === "") this.children = []; // renderList 用 textContent="" 清空容器
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceWith(newNode) {
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1) this.parentNode.children.splice(idx, 1, newNode);
    newNode.parentNode = this.parentNode;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, event = {}) {
    const ev = { target: this, preventDefault() {}, ...event };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(sel) {
    // 支持子集：`li`、`li.todo-item`、`.todo-title`、`li[data-id="x"]`、`input.edit-input`
    const tagM = sel.match(/^([a-z]+)/i);
    const tag = tagM ? tagM[1].toLowerCase() : null;
    if (tag && tag !== this.tagName.toLowerCase()) return false;
    const attrRe = /\[([a-z-]+)="([^"]*)"\]/gi;
    let m;
    while ((m = attrRe.exec(sel))) {
      const key = m[1].replace(/^data-/, ""); // data-id → dataset.id
      if (this.dataset[key] !== m[2]) return false;
    }
    const clsRe = /\.([a-z_-]+)/gi;
    while ((m = clsRe.exec(sel))) {
      if (!this.classList.contains(m[1])) return false;
    }
    return true;
  }
  querySelector(sel) {
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches?.(sel)) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
  focus() {}
  select() {}
}

const byId = {};
function makeEl(tag) {
  const el = new El(tag);
  if (tag === "input") {
    el.addEventListener = el.addEventListener.bind(el);
  }
  return el;
}
const document = {
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => byId[id],
};

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
}
const localStorage = new MemoryStorage();

const window = { localStorage };
globalThis.document = document;
globalThis.window = window;
globalThis.CSS = { escape: (s) => s };

// 构造静态 DOM（对应 index.html 结构）
const form = makeEl("form");
const input = makeEl("input");
const listEl = makeEl("ul");
const addErrorEl = makeEl("p");
const saveErrorEl = makeEl("p");
saveErrorEl.hidden = true;
addErrorEl.hidden = true;
byId["add-form"] = form;
byId["new-todo"] = input;
byId["todo-list"] = listEl;
byId["add-error"] = addErrorEl;
byId["save-error"] = saveErrorEl;

// 依序加载经典脚本（store → render → app），app.js 会挂事件监听并启动渲染
require("./store.js");
require("./render.js");
require("./app.js");
const { createStore } = globalThis.TodoStore;

function visibleTitles() {
  return listEl.children
    .filter((c) => c.tagName === "LI")
    .map((li) => li.querySelector(".todo-title").textContent);
}

test("US1 新增：提交非空标题后渲染并写入存储", () => {
  clearState();
  input.value = "  买牛奶  ";
  form.dispatch("submit");
  assert.deepEqual(visibleTitles(), ["买牛奶"]);
  assert.equal(input.value, "", "提交后应清空输入框");
  assert.ok(localStorage.getItem("todo.items"), "应写入 localStorage");
});

test("US1a 空标题：拒绝创建并提示", () => {
  clearState();
  input.value = "   ";
  form.dispatch("submit");
  assert.deepEqual(visibleTitles(), []);
  assert.equal(addErrorEl.textContent, "待办内容不能为空");
  assert.ok(input.classList.contains("field-error"));
});

test("US4 勾选切换完成状态", () => {
  clearState();
  input.value = "任务A";
  form.dispatch("submit");
  let li = listEl.children[0];
  const toggle = li.querySelector(".todo-toggle");
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  listEl.dispatch("change", { target: toggle });
  li = listEl.children[0];
  assert.equal(li.querySelector(".todo-toggle").checked, true);
  assert.ok(li.classList.contains("is-done"));
});

test("US3 删除：移除该条，其余不变", () => {
  clearState();
  input.value = "A";
  form.dispatch("submit");
  input.value = "B";
  form.dispatch("submit");
  const liB = listEl.children[1];
  const delBtn = liB.querySelector(".btn-delete");
  listEl.dispatch("click", { target: delBtn });
  assert.deepEqual(visibleTitles(), ["A"]);
});

test("US2 编辑：修改标题并保存", () => {
  clearState();
  input.value = "旧标题";
  form.dispatch("submit");
  const li = listEl.children[0];
  const editBtn = li.querySelector(".btn-edit");
  listEl.dispatch("click", { target: editBtn });
  const editEl = li.querySelector(".edit-input");
  assert.ok(editEl, "应进入行内编辑态");
  editEl.value = "新标题";
  const saveBtn = li.querySelector(".btn-save");
  listEl.dispatch("click", { target: saveBtn });
  assert.deepEqual(visibleTitles(), ["新标题"]);
});

test("US2 取消编辑：放弃修改", () => {
  clearState();
  input.value = "原标题";
  form.dispatch("submit");
  const li = listEl.children[0];
  listEl.dispatch("click", { target: li.querySelector(".btn-edit") });
  li.querySelector(".edit-input").value = "被改但取消";
  listEl.dispatch("click", { target: li.querySelector(".btn-cancel") });
  assert.deepEqual(visibleTitles(), ["原标题"]);
});

test("US5 持久化：新 store 从同一存储还原数据", () => {
  clearState();
  input.value = "持久项目";
  form.dispatch("submit");
  const store2 = createStore(localStorage);
  assert.deepEqual(
    store2.list().map((it) => it.title),
    ["持久项目"]
  );
});

test("BUG-001 编辑 A 时删除 B：保留 A 编辑态与未保存内容", () => {
  clearState();
  input.value = "A";
  form.dispatch("submit");
  input.value = "B";
  form.dispatch("submit");
  const idA = listEl.children[0].dataset.id;
  // 进入 A 编辑态并输入未保存内容
  listEl.dispatch("click", { target: listEl.children[0].querySelector(".btn-edit") });
  listEl.children[0].querySelector(".edit-input").value = "A 未保存的新内容";
  // 删除 B
  listEl.dispatch("click", { target: listEl.children[1].querySelector(".btn-delete") });
  // B 已删除，剩余仅 A
  const lis = listEl.children.filter((c) => c.tagName === "LI");
  assert.equal(lis.length, 1, "B 应被删除");
  assert.equal(lis[0].dataset.id, idA, "剩余条目应为 A");
  assert.deepEqual(
    JSON.parse(localStorage.getItem("todo.items")).map((it) => it.title),
    ["A"],
    "存储应只剩 A"
  );
  // A 编辑态保留，未保存内容不丢
  const editANew = lis[0].querySelector(".edit-input");
  assert.ok(editANew, "A 应保持编辑态");
  assert.equal(editANew.value, "A 未保存的新内容", "未保存内容应保留");
});

test("BUG-002 编辑空标题保存：提示在行内，取消后无残留", () => {
  clearState();
  input.value = "待编辑";
  form.dispatch("submit");
  listEl.dispatch("click", { target: listEl.children[0].querySelector(".btn-edit") });
  const li = listEl.children[0];
  li.querySelector(".edit-input").value = "   ";
  listEl.dispatch("click", { target: li.querySelector(".btn-save") });
  // 提示显示在编辑行内，而非顶部添加区
  const inlineErr = li.querySelector(".field-error.inline");
  assert.ok(inlineErr, "应存在行内提示元素");
  assert.equal(inlineErr.textContent, "待办内容不能为空");
  assert.equal(addErrorEl.textContent, "", "顶部添加区不应出现该提示");
  assert.equal(addErrorEl.hidden, true, "顶部添加区提示应保持隐藏");
  // 取消后：退出编辑态、行内提示随重建消失、添加区无残留、原值保留
  listEl.dispatch("click", { target: li.querySelector(".btn-cancel") });
  const liAfter = listEl.children[0];
  assert.equal(liAfter.querySelector(".edit-input"), null, "取消后应退出编辑态");
  assert.equal(liAfter.querySelector(".field-error.inline"), null, "取消后行内提示不应残留");
  assert.equal(addErrorEl.textContent, "", "取消后顶部添加区无残留");
  assert.deepEqual(
    JSON.parse(localStorage.getItem("todo.items")).map((it) => it.title),
    ["待编辑"],
    "原值应保留"
  );
});

function clearState() {
  localStorage.map.clear();
  byId["new-todo"].value = "";
  byId["new-todo"].classList.remove("field-error");
  byId["add-error"].textContent = "";
  byId["add-error"].hidden = true;
  byId["save-error"].textContent = "";
  byId["save-error"].hidden = true;
  listEl.children = [];
  listEl.textContent = "";
}