import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
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

const SAMPLE_SQL = `select u.id,u.name,o.order_id,o.total_amount,count(distinct p.id) as pay_cnt,sum(case when o.status = 'paid' then o.total_amount else 0 end) as paid_amount from user_profile u left join order_fact o on u.id=o.user_id left join payment_fact p on o.order_id = p.order_id where u.country='CN' and o.created_at >= '2026-01-01' group by u.id,u.name,o.order_id,o.total_amount order by paid_amount desc limit 100;`;

const worker = new Worker(new URL("./sql-worker.js", import.meta.url), { type: "module" });
let nextRequestId = 0;
let latestFormatId = 0;
let latestAnalysisId = 0;
let latestAnalysisTimer = 0;

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
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleAnalysis();
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

renderAnalysis({ tables: [], unknownFields: [] });
