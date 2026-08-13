// app.js — 交互层：事件绑定、表单校验、行内编辑状态机、启动加载
//
// 经典脚本（file:// 直接打开可用）。依赖全局 `TodoStore`（store.js）与
// `TodoRender`（render.js），加载顺序：store.js → render.js → app.js。

(function () {
  "use strict";

  var createStore = globalThis.TodoStore.createStore;
  var renderList = globalThis.TodoRender.renderList;

  var form = document.getElementById("add-form");
  var input = document.getElementById("new-todo");
  var listEl = document.getElementById("todo-list");
  var addErrorEl = document.getElementById("add-error");
  var saveErrorEl = document.getElementById("save-error");

  var store = createStore(window.localStorage);

  // 行内编辑状态机：idle ⇄ editing(id)
  var currentEditId = null;
  var editInput = null;
  var editErrorEl = null;

  function show(el, message) {
    if (el.hidden !== undefined) el.hidden = false;
    el.textContent = message;
  }

  function clear(el) {
    if (el.hidden !== undefined) el.hidden = true;
    el.textContent = "";
  }

  function handleSaveError(err) {
    show(saveErrorEl, "保存失败：" + (err && err.message ? err.message : "请重试"));
  }

  function rerender() {
    // 若存在进行中的行内编辑，重建前保留其目标与未保存内容，重建后恢复编辑态。
    // 修复 BUG-001：删除/勾选/新增其他条目时不再静默丢弃编辑中的用户输入。
    var pending = null;
    if (currentEditId !== null && editInput) {
      pending = { id: currentEditId, value: editInput.value };
      exitEdit();
    }
    renderList(listEl, store.list());
    if (pending) {
      var item = store.list().find(function (it) {
        return it.id === pending.id;
      });
      if (item) enterEdit(item, pending.value);
    }
  }

  function exitEdit() {
    currentEditId = null;
    editInput = null;
    editErrorEl = null;
  }

  function cancelEdit() {
    exitEdit();
    rerender();
  }

  function saveEdit(id) {
    if (!editInput) return;
    try {
      store.update(id, { title: editInput.value });
      exitEdit();
      rerender();
    } catch (err) {
      if (err && err.code === "EMPTY_TITLE") {
        editInput.classList.add("field-error");
        // 修复 BUG-002：空标题提示显示在编辑行内，而非页面顶部添加区
        if (editErrorEl) show(editErrorEl, "待办内容不能为空");
      } else {
        handleSaveError(err);
      }
    }
  }

  function enterEdit(item, initialValue) {
    if (currentEditId !== null) cancelEdit();
    currentEditId = item.id;

    var li = listEl.querySelector('li[data-id="' + CSS.escape(item.id) + '"]');
    if (!li) {
      exitEdit();
      return;
    }
    li.classList.add("is-editing");

    var title = li.querySelector(".todo-title");
    var actions = li.querySelector(".todo-actions");
    var toggle = li.querySelector(".todo-toggle");
    if (toggle) toggle.disabled = true; // 编辑期间禁用勾选，避免状态冲突

    var editInputEl = document.createElement("input");
    editInputEl.type = "text";
    editInputEl.className = "edit-input";
    editInputEl.value = initialValue !== undefined ? initialValue : item.title;
    title.replaceWith(editInputEl);
    editInput = editInputEl;

    var errEl = document.createElement("p");
    errEl.className = "field-error inline";
    errEl.setAttribute("role", "alert");
    li.appendChild(errEl);
    editErrorEl = errEl;

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-save";
    saveBtn.textContent = "保存";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "取消";
    actions.textContent = "";
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    saveBtn.addEventListener("click", function () {
      saveEdit(item.id);
    });
    cancelBtn.addEventListener("click", cancelEdit);
    editInputEl.addEventListener("input", function () {
      editInputEl.classList.remove("field-error");
      if (editErrorEl) clear(editErrorEl);
    });
    editInputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        saveEdit(item.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    });

    editInputEl.focus();
    editInputEl.select();
  }

  // ---- 新增 ----
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var value = input.value;
    try {
      store.add(value);
      input.value = "";
      input.classList.remove("field-error");
      clear(addErrorEl);
      rerender();
      input.focus();
    } catch (err) {
      if (err && err.code === "EMPTY_TITLE") {
        input.classList.add("field-error");
        show(addErrorEl, "待办内容不能为空");
      } else {
        handleSaveError(err);
      }
    }
  });

  input.addEventListener("input", function () {
    input.classList.remove("field-error");
    clear(addErrorEl);
  });

  // ---- 列表事件（委托）----
  listEl.addEventListener("click", function (e) {
    var li = e.target.closest("li.todo-item");
    if (!li) return;
    var id = li.dataset.id;

    if (e.target.classList.contains("btn-edit")) {
      var item = store.list().find(function (it) {
        return it.id === id;
      });
      if (item) enterEdit(item);
    } else if (e.target.classList.contains("btn-delete")) {
      try {
        store.remove(id);
      } catch (err) {
        handleSaveError(err);
      }
      if (currentEditId === id) exitEdit();
      rerender();
    } else if (e.target.classList.contains("btn-save")) {
      saveEdit(id);
    } else if (e.target.classList.contains("btn-cancel")) {
      cancelEdit();
    }
  });

  listEl.addEventListener("change", function (e) {
    if (!e.target.classList.contains("todo-toggle")) return;
    var li = e.target.closest("li.todo-item");
    if (!li) return;
    try {
      store.toggleDone(li.dataset.id);
    } catch (err) {
      handleSaveError(err);
    }
    rerender();
  });

  // ---- 启动加载（经典脚本位于 body 末尾，DOM 已解析，直接渲染）----
  rerender();
})();