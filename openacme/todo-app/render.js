// render.js — 渲染层（只读状态、只写 DOM）
//
// 经典脚本，挂到全局 `TodoRender`（file:// 直接打开可用）。
// 安全约定：标题一律用 textContent / createTextNode，禁止 innerHTML 拼接用户输入。

(function (global) {
  "use strict";

  function createTodoItem(item) {
    var li = document.createElement("li");
    li.className = "todo-item";
    if (item.done) li.classList.add("is-done");
    li.dataset.id = item.id;

    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "todo-toggle";
    toggle.checked = item.done;
    toggle.setAttribute("aria-label", "标记完成");
    li.appendChild(toggle);

    var title = document.createElement("span");
    title.className = "todo-title";
    title.textContent = item.title;
    li.appendChild(title);

    var actions = document.createElement("div");
    actions.className = "todo-actions";

    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn-edit";
    editBtn.textContent = "编辑";
    actions.appendChild(editBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "删除";
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
    return li;
  }

  function createEmptyState() {
    var div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = "暂无待办，输入上方内容开始记录";
    return div;
  }

  function renderList(container, items) {
    container.textContent = "";
    if (!items.length) {
      container.appendChild(createEmptyState());
      return;
    }
    items.forEach(function (item) {
      container.appendChild(createTodoItem(item));
    });
  }

  global.TodoRender = {
    createTodoItem: createTodoItem,
    createEmptyState: createEmptyState,
    renderList: renderList,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);