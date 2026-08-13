// store.js — 数据层（纯 JS，不依赖 DOM / 浏览器全局）
//
// 双模式模块（UMD）：
//  - 浏览器经典脚本：挂到全局 `TodoStore`（file:// 直接打开即可用，不受 ESM CORS 限制）
//  - Node 单测：`require("./store.js")` 得到 { STORAGE_KEY, genId, createStore }
//
// createStore(storage)：storage 为可注入的存储适配器，需提供
//   getItem(key) / setItem(key, value)。
// 默认可传 window.localStorage（浏览器）；单测注入内存 mock。
//
// 存储键：todo.items（单一键，全量覆盖写 JSON 数组）。
// 条目结构：{ id, title, done, createdAt, updatedAt }

(function (global) {
  "use strict";

  var STORAGE_KEY = "todo.items";

  // 生成全局唯一 id（优先 crypto.randomUUID，降级随机兜底）
  function genId() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function emptyTitleError() {
    var err = new Error("待办内容不能为空");
    err.code = "EMPTY_TITLE";
    return err;
  }

  function createStore(storage) {
    function read() {
      var raw;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch (e) {
        console.warn("[store] 读取本地数据失败，回退为空列表", e);
        return [];
      }
      if (!raw) return [];
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.warn("[store] 本地数据为非法 JSON，回退为空列表", e);
        return [];
      }
    }

    function write(items) {
      // 存储异常（容量/隐私模式）由调用方捕获并就地提示
      storage.setItem(STORAGE_KEY, JSON.stringify(items));
    }

    function list() {
      return read();
    }

    function add(title) {
      var trimmed = String(title).trim();
      if (!trimmed) throw emptyTitleError();

      var items = read();
      var now = new Date().toISOString();
      var item = {
        id: genId(),
        title: trimmed,
        done: false,
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      write(items);
      return item;
    }

    function update(id, patch) {
      var items = read();
      var idx = items.findIndex(function (it) {
        return it.id === id;
      });
      if (idx === -1) return null;

      if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        var trimmed = String(patch.title).trim();
        if (!trimmed) throw emptyTitleError();
        items[idx].title = trimmed;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "done")) {
        items[idx].done = Boolean(patch.done);
      }
      items[idx].updatedAt = new Date().toISOString();
      write(items);
      return items[idx];
    }

    function toggleDone(id) {
      var items = read();
      var idx = items.findIndex(function (it) {
        return it.id === id;
      });
      if (idx === -1) return null;
      items[idx].done = !items[idx].done;
      items[idx].updatedAt = new Date().toISOString();
      write(items);
      return items[idx];
    }

    function remove(id) {
      var items = read();
      var idx = items.findIndex(function (it) {
        return it.id === id;
      });
      if (idx === -1) return false;
      items.splice(idx, 1);
      write(items);
      return true;
    }

    return { list: list, add: add, update: update, toggleDone: toggleDone, remove: remove };
  }

  var api = { STORAGE_KEY: STORAGE_KEY, genId: genId, createStore: createStore };

  // Node / CommonJS
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  // 浏览器经典脚本（file:// 直接打开）
  global.TodoStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);