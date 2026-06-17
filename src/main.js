import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { SearchQuery, highlightSelectionMatches, search, setSearchQuery } from "@codemirror/search";
import { sql, MySQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const analysisPanel = document.querySelector("#analysisPanel");
const tableCount = document.querySelector("#tableCount");
const fieldCount = document.querySelector("#fieldCount");
const aliasCount = document.querySelector("#aliasCount");
const formatBtn = document.querySelector("#formatBtn");
const pasteBtn = document.querySelector("#pasteBtn");
const copyBtn = document.querySelector("#copyBtn");
const clearBtn = document.querySelector("#clearBtn");
const loadSampleBtn = document.querySelector("#loadSampleBtn");
const searchBar = document.querySelector("#searchBar");
const searchInput = document.querySelector("#searchInput");
const searchCount = document.querySelector("#searchCount");
const searchPrevBtn = document.querySelector("#searchPrevBtn");
const searchNextBtn = document.querySelector("#searchNextBtn");
const searchCaseBtn = document.querySelector("#searchCaseBtn");
const searchWordBtn = document.querySelector("#searchWordBtn");
const searchRegexBtn = document.querySelector("#searchRegexBtn");

const SAMPLE_SQL = `select u.id,u.name,o.order_id,o.total_amount,count(distinct p.id) as pay_cnt,sum(case when o.status = 'paid' then o.total_amount else 0 end) as paid_amount from user_profile u left join order_fact o on u.id=o.user_id left join payment_fact p on o.order_id = p.order_id where u.country='CN' and o.created_at >= '2026-01-01' group by u.id,u.name,o.order_id,o.total_amount order by paid_amount desc limit 100;`;
const MAX_SEARCH_MATCHES = 5000;

const worker = new Worker(new URL("./sql-worker.js", import.meta.url), { type: "module" });
let nextRequestId = 0;
let latestFormatId = 0;
let latestAnalysisId = 0;
let latestAnalysisTimer = 0;
let searchMatches = [];
let searchTruncated = false;

const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#d98954", fontWeight: "700" },
  { tag: [tags.function(tags.variableName), tags.standard(tags.variableName)], color: "#5fb3ff", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#7cc487" },
  { tag: tags.number, color: "#4fd1c5" },
  { tag: [tags.variableName, tags.propertyName, tags.name], color: "#d0d3da" },
  { tag: tags.operator, color: "#c7cad1" },
  { tag: tags.comment, color: "#6b7280", fontStyle: "italic" },
  { tag: tags.punctuation, color: "#c7cad1" }
]);

const editor = new EditorView({
  parent: document.querySelector("#sqlInput"),
  state: EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      sql({ dialect: MySQL }),
      syntaxHighlighting(sqlHighlight),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([
        {
          key: "Mod-f",
          run: () => {
            focusSearchInput();
            return true;
          }
        },
        {
          key: "F3",
          run: () => {
            gotoSearchMatch("next");
            return true;
          }
        },
        {
          key: "Mod-g",
          run: () => {
            gotoSearchMatch("next");
            return true;
          }
        },
        {
          key: "Shift-F3",
          run: () => {
            gotoSearchMatch("previous");
            return true;
          }
        },
        {
          key: "Shift-Mod-g",
          run: () => {
            gotoSearchMatch("previous");
            return true;
          }
        },
        ...defaultKeymap,
        ...historyKeymap
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleAnalysis();
        if (update.docChanged || update.selectionSet) updateSearchStats();
      })
    ]
  })
});

worker.addEventListener("message", (event) => {
  const { id, type, formatted, analysis, error } = event.data;
  if (type === "format" && id !== latestFormatId) return;
  if (type === "analyze" && id !== latestAnalysisId) return;

  if (error) {
    if (type === "format") {
      formatBtn.disabled = false;
      formatBtn.textContent = "格式化";
    }
    renderAnalysis({ tables: [], unknownFields: [`格式化失败: ${error}`] });
    return;
  }

  if (type === "format") {
    formatBtn.disabled = false;
    formatBtn.textContent = "格式化";
    replaceEditorText(formatted);
  }
  renderAnalysis(analysis);
});

function getEditorText() {
  return editor.state.doc.toString();
}

function replaceEditorText(text) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text }
  });
  updateSearchStats();
}

function sendWorker(type, sqlText) {
  const id = ++nextRequestId;
  if (type === "format") latestFormatId = id;
  else latestAnalysisId = id;
  worker.postMessage({ id, type, sql: sqlText });
}

function scheduleAnalysis() {
  window.clearTimeout(latestAnalysisTimer);
  latestAnalysisTimer = window.setTimeout(() => {
    const text = getEditorText().trim();
    if (!text) {
      renderAnalysis({ tables: [], unknownFields: [] });
      return;
    }
    sendWorker("analyze", text);
  }, 360);
}

function formatCurrentSql() {
  const text = getEditorText().trim();
  if (!text) return;
  window.clearTimeout(latestAnalysisTimer);
  formatBtn.disabled = true;
  formatBtn.textContent = "格式化中";
  sendWorker("format", text);
}

function focusSearchInput() {
  showSearchPanel({ prefillSelection: true });
}

function showSearchPanel({ prefillSelection = false } = {}) {
  searchBar.hidden = false;

  if (prefillSelection) {
    const selection = editor.state.selection.main;
    const selectedText = selection.empty ? "" : editor.state.sliceDoc(selection.from, selection.to);
    if (selectedText && !selectedText.includes("\n") && selectedText.length <= 120) {
      searchInput.value = selectedText;
      applySearchQuery();
    }
  }

  requestAnimationFrame(() => {
    searchInput.focus();
    searchInput.select();
  });
}

function hideSearchPanel() {
  searchBar.hidden = true;
  searchInput.value = "";
  applySearchQuery();
  searchInput.blur();
  editor.focus();
}

function buildSearchQuery() {
  return new SearchQuery({
    search: searchInput.value,
    caseSensitive: searchCaseBtn.getAttribute("aria-pressed") === "true",
    wholeWord: searchWordBtn.getAttribute("aria-pressed") === "true",
    regexp: searchRegexBtn.getAttribute("aria-pressed") === "true"
  });
}

function applySearchQuery({ selectNearest = false } = {}) {
  const query = buildSearchQuery();
  editor.dispatch({ effects: setSearchQuery.of(query) });
  updateSearchStats(query);
  if (selectNearest) selectNearestSearchMatch({ focusEditor: false });
}

function collectSearchMatches(query = buildSearchQuery()) {
  searchTruncated = false;
  if (!query.search || !query.valid) return [];

  const matches = [];
  const cursor = query.getCursor(editor.state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value;
    if (from === to) continue;
    matches.push({ from, to });
    if (matches.length >= MAX_SEARCH_MATCHES) {
      searchTruncated = true;
      break;
    }
  }
  return matches;
}

function getCurrentSearchIndex(matches = searchMatches) {
  const selection = editor.state.selection.main;
  const exactIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  if (exactIndex >= 0) return exactIndex;
  return matches.findIndex((match) => selection.from >= match.from && selection.from <= match.to);
}

function getNearestSearchIndex(matches = searchMatches) {
  const position = editor.state.selection.main.from;
  const nextIndex = matches.findIndex((match) => match.from >= position);
  return nextIndex >= 0 ? nextIndex : 0;
}

function updateSearchStats(query = buildSearchQuery()) {
  searchMatches = collectSearchMatches(query);
  searchInput.classList.toggle("is-invalid", Boolean(query.search && !query.valid));
  searchInput.classList.toggle("has-no-match", Boolean(query.search && query.valid && !searchMatches.length));

  const hasMatches = searchMatches.length > 0;
  searchPrevBtn.disabled = !hasMatches;
  searchNextBtn.disabled = !hasMatches;

  if (!query.search) {
    searchCount.textContent = "0/0";
    return;
  }
  if (!query.valid) {
    searchCount.textContent = "正则无效";
    return;
  }
  if (!hasMatches) {
    searchCount.textContent = "0/0";
    return;
  }

  const activeIndex = getCurrentSearchIndex();
  const displayIndex = activeIndex >= 0 ? activeIndex : getNearestSearchIndex();
  searchCount.textContent = `${displayIndex + 1}/${searchMatches.length}${searchTruncated ? "+" : ""}`;
}

function selectSearchMatch(match, { focusEditor = true } = {}) {
  editor.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: "center" })
  });
  if (focusEditor) editor.focus();
  updateSearchStats();
}

function selectNearestSearchMatch(options = {}) {
  if (!searchMatches.length) return;
  selectSearchMatch(searchMatches[getNearestSearchIndex()], options);
}

function gotoSearchMatch(direction, options = {}) {
  applySearchQuery();
  if (!searchMatches.length) return;

  const currentIndex = getCurrentSearchIndex();
  const nearestIndex = getNearestSearchIndex();
  let targetIndex;
  if (direction === "previous") {
    targetIndex = currentIndex >= 0 ? currentIndex - 1 : nearestIndex - 1;
    if (targetIndex < 0) targetIndex = searchMatches.length - 1;
  } else {
    targetIndex = currentIndex >= 0 ? currentIndex + 1 : nearestIndex;
    if (targetIndex >= searchMatches.length) targetIndex = 0;
  }
  selectSearchMatch(searchMatches[targetIndex], options);
}

function toggleSearchOption(button) {
  const pressed = button.getAttribute("aria-pressed") === "true";
  button.setAttribute("aria-pressed", String(!pressed));
  applySearchQuery({ selectNearest: Boolean(searchInput.value) });
  searchInput.focus();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAnalysis(analysis) {
  const aliasesTotal = analysis.tables.reduce((sum, table) => sum + table.aliases.length, 0);
  const fieldsTotal = analysis.tables.reduce((sum, table) => sum + table.fields.length, 0) + analysis.unknownFields.length;

  tableCount.textContent = String(analysis.tables.length);
  fieldCount.textContent = String(fieldsTotal);
  aliasCount.textContent = String(aliasesTotal);

  if (!analysis.tables.length && !analysis.unknownFields.length) {
    analysisPanel.innerHTML = `<div class="empty-state">粘贴 SQL 后会在这里展示表、别名和字段引用。</div>`;
    return;
  }

  const cards = analysis.tables.map((table) => {
    const fields = table.fields.length
      ? table.fields.map((field) => `<span class="field-chip">${escapeHtml(field)}</span>`).join("")
      : `<span class="field-chip muted">未识别到限定字段</span>`;
    const aliases = table.aliases.length
      ? `<span class="alias-pill">${escapeHtml(table.aliases.join(", "))}</span>`
      : `<span class="alias-pill">无别名</span>`;

    return `
      <article class="table-card">
        <header>
          <div class="table-name">${escapeHtml(table.name)}</div>
          ${aliases}
        </header>
        <div class="field-list">${fields}</div>
      </article>
    `;
  });

  if (analysis.unknownFields.length) {
    cards.push(`
      <article class="table-card">
        <header>
          <div class="table-name">未限定 / 未知表</div>
          <span class="alias-pill">${analysis.unknownFields.length} 个</span>
        </header>
        <div class="field-list">
          ${analysis.unknownFields.map((field) => `<span class="field-chip">${escapeHtml(field)}</span>`).join("")}
        </div>
      </article>
    `);
  }

  analysisPanel.innerHTML = cards.join("");
}

formatBtn.addEventListener("click", formatCurrentSql);
loadSampleBtn.addEventListener("click", () => {
  replaceEditorText(SAMPLE_SQL);
  formatCurrentSql();
});
clearBtn.addEventListener("click", () => {
  replaceEditorText("");
  renderAnalysis({ tables: [], unknownFields: [] });
  editor.focus();
});
copyBtn.addEventListener("click", async () => {
  const text = getEditorText().trim();
  if (text) await navigator.clipboard.writeText(text);
});
pasteBtn.addEventListener("click", async () => {
  replaceEditorText(await navigator.clipboard.readText());
  formatCurrentSql();
});
searchInput.addEventListener("input", () => {
  applySearchQuery({ selectNearest: Boolean(searchInput.value) });
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    gotoSearchMatch(event.shiftKey ? "previous" : "next", { focusEditor: false });
    searchInput.focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideSearchPanel();
  }
});
searchPrevBtn.addEventListener("click", () => gotoSearchMatch("previous"));
searchNextBtn.addEventListener("click", () => gotoSearchMatch("next"));
searchCaseBtn.addEventListener("click", () => toggleSearchOption(searchCaseBtn));
searchWordBtn.addEventListener("click", () => toggleSearchOption(searchWordBtn));
searchRegexBtn.addEventListener("click", () => toggleSearchOption(searchRegexBtn));
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    showSearchPanel({ prefillSelection: true });
  }
});

renderAnalysis({ tables: [], unknownFields: [] });
updateSearchStats();
