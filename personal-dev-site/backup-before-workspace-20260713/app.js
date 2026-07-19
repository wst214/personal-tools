(function () {
  const searchInput = document.querySelector("#globalSearch");
  const clearButton = document.querySelector("[data-clear-search]");
  const resetButton = document.querySelector("[data-reset-all]");
  const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
  const cards = Array.from(document.querySelectorAll("[data-project-grid] .project-card"));
  const emptyState = document.querySelector("[data-empty-state]");

  if (!searchInput || !cards.length) return;

  let activeFilter = "all";

  function normalize(value) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000\-_/.,:;，。；：、|]+/g, "");
  }

  function searchableText(card) {
    return normalize([
      card.getAttribute("data-title") || "",
      card.getAttribute("data-category") || "",
      card.textContent || "",
    ].join(" "));
  }

  function updateCards() {
    const query = normalize(searchInput.value);
    let visibleCount = 0;

    cards.forEach((card) => {
      const category = card.getAttribute("data-category") || "";
      const title = searchableText(card);
      const matchesCategory = activeFilter === "all" || category === activeFilter;
      const matchesSearch = !query || title.includes(query);
      const visible = matchesCategory && matchesSearch;

      card.hidden = !visible;
      if (visible) visibleCount += 1;
    });

    if (emptyState) {
      const hasUserConstraint = Boolean(query) || activeFilter !== "all";
      emptyState.hidden = visibleCount !== 0 || !hasUserConstraint;
    }
  }

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.getAttribute("data-filter") || "all";
      filterButtons.forEach((item) => item.classList.toggle("active", item === button));
      updateCards();
    });
  });

  searchInput.addEventListener("input", updateCards);

  if (clearButton) {
    clearButton.addEventListener("click", () => {
      searchInput.value = "";
      searchInput.focus();
      updateCards();
    });
  }

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      searchInput.value = "";
      activeFilter = "all";
      filterButtons.forEach((item) => {
        item.classList.toggle("active", item.getAttribute("data-filter") === "all");
      });
      updateCards();
    });
  }

  searchInput.value = "";
  updateCards();
})();
