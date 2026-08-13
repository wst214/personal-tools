// store.test.js — 数据层单测（Node 直测，注入内存 mock storage）
// 运行：node --test store.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createStore, STORAGE_KEY } = require("./store.js");

// 内存 mock storage：与 localStorage 相同的 getItem/setItem 接口
class MemoryStorage {
  constructor(initial) {
    this.map = new Map(initial || []);
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
}

function makeStore(initial) {
  const storage = new MemoryStorage(initial);
  const store = createStore(storage);
  return { store, storage };
}

test("add 合法：追加 done=false 的条目，生成 id/createdAt/updatedAt", () => {
  const { store, storage } = makeStore();
  const item = store.add("  写周报  "); // 首尾空白应去除
  assert.equal(item.title, "写周报");
  assert.equal(item.done, false);
  assert.ok(item.id && typeof item.id === "string");
  assert.ok(item.createdAt && !Number.isNaN(Date.parse(item.createdAt)));
  assert.ok(item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt)));
  assert.equal(store.list().length, 1);
  assert.ok(storage.getItem(STORAGE_KEY), "应已写入 localStorage");
});

test("add 空标题：拒绝并抛错，不写入", () => {
  const { store, storage } = makeStore();
  assert.throws(() => store.add(""), /不能为空/);
  assert.throws(() => store.add("   "), /不能为空/);
  assert.equal(store.list().length, 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("update：标题更新、updatedAt 更新、其余字段不变", () => {
  const { store } = makeStore();
  const item = store.add("旧标题");
  const before = item.updatedAt;
  const updated = store.update(item.id, { title: "  新标题  " });
  assert.equal(updated.title, "新标题");
  assert.equal(updated.id, item.id);
  assert.equal(updated.done, item.done);
  assert.equal(updated.createdAt, item.createdAt);
  assert.ok(
    Date.parse(updated.updatedAt) >= Date.parse(before),
    "updatedAt 应更新"
  );
  assert.equal(store.list()[0].title, "新标题");
});

test("update 空标题：拒绝，维持原值不写", () => {
  const { store } = makeStore();
  const item = store.add("原标题");
  assert.throws(() => store.update(item.id, { title: "  " }), /不能为空/);
  assert.equal(store.list()[0].title, "原标题");
});

test("update 不存在 id：返回 null", () => {
  const { store } = makeStore();
  assert.equal(store.update("nope", { title: "x" }), null);
});

test("toggleDone：done 反转、updatedAt 更新", () => {
  const { store } = makeStore();
  const item = store.add("任务");
  assert.equal(item.done, false);
  const t1 = store.toggleDone(item.id);
  assert.equal(t1.done, true);
  const t2 = store.toggleDone(item.id);
  assert.equal(t2.done, false);
  assert.ok(Date.parse(t2.updatedAt) >= Date.parse(t1.updatedAt));
});

test("toggleDone 不存在 id：返回 null", () => {
  const { store } = makeStore();
  assert.equal(store.toggleDone("nope"), null);
});

test("remove：删除指定条，其余顺序与内容不变", () => {
  const { store } = makeStore();
  const a = store.add("A");
  store.add("B");
  const c = store.add("C");
  assert.equal(store.remove(a.id), true);
  const left = store.list();
  assert.deepEqual(
    left.map((it) => it.title),
    ["B", "C"]
  );
  // 顺序保持：B 仍在 C 之前
  assert.deepEqual(
    left.map((it) => it.title),
    ["B", "C"]
  );
});

test("remove 不存在 id：返回 false", () => {
  const { store } = makeStore();
  assert.equal(store.remove("nope"), false);
});

test("序列化往返：add 后从存储读回可还原数组且字段完整", () => {
  const { store, storage } = makeStore();
  store.add("第一条");
  store.add("第二条");
  const raw = storage.getItem(STORAGE_KEY);
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  for (const it of parsed) {
    assert.ok(it.id);
    assert.ok(it.title);
    assert.equal(typeof it.done, "boolean");
    assert.ok(it.createdAt);
    assert.ok(it.updatedAt);
  }
  // 重新以同一存储构造 store，list 应还原
  const store2 = createStore(storage);
  assert.equal(store2.list().length, 2);
});

test("损坏数据：存储为非法 JSON 时回退 []，不崩溃", () => {
  const { store } = makeStore([[STORAGE_KEY, "{not json!!"]]);
  assert.deepEqual(store.list(), []);
});

test("空存储：无 todo.items 或值为空时 list() 返回 []", () => {
  const empty = makeStore();
  assert.deepEqual(empty.store.list(), []);
  const nullStore = makeStore([[STORAGE_KEY, null]]);
  assert.deepEqual(nullStore.store.list(), []);
  const emptyArr = makeStore([[STORAGE_KEY, "[]"]]);
  assert.deepEqual(emptyArr.store.list(), []);
});

test("持久化异常：setItem 抛错时 add 向上抛错，不静默丢失", () => {
  const storage = new MemoryStorage();
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const store = createStore(storage);
  assert.throws(() => store.add("保存会失败"), /QuotaExceededError/);
});