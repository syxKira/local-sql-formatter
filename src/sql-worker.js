const KEYWORDS = new Set([
  "add", "all", "alter", "and", "as", "asc", "between", "by", "case", "cast",
  "create", "cross", "database", "delete", "desc", "distinct", "drop", "else",
  "end", "exists", "false", "from", "full", "group", "having", "if", "in",
  "inner", "insert", "into", "is", "join", "left", "like", "limit", "not",
  "null", "offset", "on", "or", "order", "outer", "over", "partition", "right",
  "select", "set", "then", "true", "union", "update", "using", "values",
  "when", "where", "with"
]);

const FUNCTIONS = new Set([
  "avg", "cast", "coalesce", "concat", "count", "date", "date_add", "date_format",
  "from_unixtime", "if", "ifnull", "lower", "max", "min", "round", "sum", "substring",
  "trim", "upper"
]);

const RESERVED_ALIAS_STOP = new Set([
  "on", "where", "join", "left", "right", "inner", "outer", "full", "cross",
  "group", "order", "having", "limit", "union", "set", "values", "using", "and",
  "or", "when", "then", "else", "end"
]);

const MAX_ALIAS_ALIGNMENT_COLUMN = 96;
const MAX_ALIAS_ALIGNMENT_PADDING = 40;
const MAX_INLINE_CASE_LENGTH = 100;
const MAX_LINE_LENGTH = 120;

self.addEventListener("message", (event) => {
  const { id, type, sql } = event.data;
  try {
    const normalized = normalizePastedSql(sql);
    if (type === "format") {
      const formatted = formatSql(normalized);
      self.postMessage({ id, type, formatted, analysis: analyzeSql(formatted) });
      return;
    }
    self.postMessage({ id, type, analysis: analyzeSql(normalized) });
  } catch (error) {
    self.postMessage({ id, type, error: error instanceof Error ? error.message : String(error) });
  }
});

function tokenize(sql) {
  const tokens = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      tokens.push({ type: "comment", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < sql.length && !(sql[j] === "*" && sql[j + 1] === "/")) j += 1;
      j = Math.min(j + 2, sql.length);
      tokens.push({ type: "comment", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "#") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$#]/.test(sql[j])) j += 1;
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\" && j + 1 < sql.length) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ type: quote === "`" ? "quoted" : "string", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[0-9._]/.test(sql[j])) j += 1;
      tokens.push({ type: "number", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    const two = sql.slice(i, i + 2);
    if ([">=", "<=", "<>", "!=", "||", "&&", ":=", "->"].includes(two)) {
      tokens.push({ type: "operator", value: two });
      i += 2;
      continue;
    }

    tokens.push({
      type: "()[],.;".includes(ch) ? "punctuation" : "operator",
      value: ch
    });
    i += 1;
  }

  return tokens;
}

function lowerValue(token) {
  return token.value.toLowerCase();
}

function displayToken(token) {
  const lower = lowerValue(token);
  if (token.type === "word" && KEYWORDS.has(lower)) return lower;
  return token.value;
}

function nextMeaningful(tokens, index) {
  let i = index + 1;
  while (tokens[i] && tokens[i].type === "comment") i += 1;
  return tokens[i];
}

function previousMeaningful(tokens, index) {
  let i = index - 1;
  while (tokens[i] && tokens[i].type === "comment") i -= 1;
  return { token: tokens[i], index: i };
}

function isDistinctFromOperator(tokens, index) {
  if (lowerValue(tokens[index]) !== "from") return false;

  const previous = previousMeaningful(tokens, index);
  if (lowerValue(previous.token ?? { value: "" }) !== "distinct") return false;

  const beforeDistinct = previousMeaningful(tokens, previous.index);
  const beforeDistinctLower = lowerValue(beforeDistinct.token ?? { value: "" });
  if (beforeDistinctLower === "is") return true;
  if (beforeDistinctLower !== "not") return false;

  const beforeNot = previousMeaningful(tokens, beforeDistinct.index);
  return lowerValue(beforeNot.token ?? { value: "" }) === "is";
}

function looksLikeSql(value) {
  return /\b(select|set|with|insert|update|delete|from)\b/i.test(value);
}

function stripWrappingSqlQuotes(sql) {
  const trimmed = sql.trim();
  if (trimmed.length < 2) return { text: trimmed, stripped: false };

  const quotePairs = new Map([
    ['"', '"'],
    ["“", "”"],
    ["”", "”"],
    ["＂", "＂"]
  ]);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (quotePairs.get(first) !== last) return { text: trimmed, stripped: false };

  const inner = trimmed.slice(1, -1).trim();
  return looksLikeSql(inner) ? { text: inner, stripped: true } : { text: trimmed, stripped: false };
}

function parseJsonSqlString(sql) {
  const trimmed = sql.trim();
  if (trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && looksLikeSql(parsed)) return parsed.trim();
  } catch {
    return null;
  }
  return null;
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function shouldDecodeEscapedSql(value, strippedWrappingQuotes) {
  if (!looksLikeSql(value)) return false;

  const escapedQuotes = countMatches(value, /\\["'`]/g);
  const escapedNewlines = countMatches(value, /\\[rnt]/g);
  const escapedIdentifiers = countMatches(value, /\\["`][#A-Za-z_][^"`\\]{0,120}\\["`]/g);

  if (strippedWrappingQuotes && (escapedQuotes > 0 || escapedNewlines > 0)) return true;
  return escapedIdentifiers >= 2 || escapedQuotes >= 4 || escapedNewlines >= 2;
}

function decodeStringEscapes(value) {
  let decoded = "";

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (ch !== "\\" || next === undefined) {
      decoded += ch;
      continue;
    }

    if (next === "n") decoded += "\n";
    else if (next === "r") decoded += "\r";
    else if (next === "t") decoded += "\t";
    else if (next === "b") decoded += "\b";
    else if (next === "f") decoded += "\f";
    else if (next === '"' || next === "'" || next === "`" || next === "\\") decoded += next;
    else {
      decoded += ch + next;
    }
    i += 1;
  }

  return decoded;
}

function normalizePastedSql(sql) {
  const parsedJson = parseJsonSqlString(sql);
  if (parsedJson !== null) return parsedJson;

  const stripped = stripWrappingSqlQuotes(sql);
  let normalized = stripped.text;

  for (let pass = 0; pass < 2; pass += 1) {
    if (!shouldDecodeEscapedSql(normalized, stripped.stripped || pass > 0)) break;
    const decoded = decodeStringEscapes(normalized);
    if (decoded === normalized) break;
    normalized = decoded.trim();
  }

  return normalized;
}

function formatSql(sql) {
  const tokens = tokenize(sql);
  if (!tokens.length) return "";

  const out = [];
  let line = "";
  const parens = [];
  const selectAnchors = [];
  const caseStack = [];
  const clauseStack = ["root"];
  let previousToken = null;

  const flushLine = () => {
    out.push(line.replace(/\s+$/, ""));
    line = "";
  };
  const newLineAt = (col) => {
    flushLine();
    line = " ".repeat(Math.max(col, 0));
  };
  const hasContent = () => line.replace(/^ +/, "") !== "";
  const lineIndent = () => line.match(/^ */)[0].length;
  const baseCol = () => {
    const top = parens[parens.length - 1];
    return top ? top.col + 1 : 0;
  };
  const currentSelectAnchor = () => {
    const top = selectAnchors[selectAnchors.length - 1];
    return top && top.depth === parens.length ? top.anchor : null;
  };
  const commentIndent = () => {
    const selectAnchor = currentSelectAnchor();
    if (selectAnchor !== null) return selectAnchor;
    if (hasContent()) return Math.max(baseCol(), lineIndent());
    return baseCol();
  };
  const maybeWrapBefore = (token, prev) => {
    if (!hasContent()) return;
    if ([",", ".", ")", ";"].includes(token.value)) return;

    const value = displayToken(token);
    const extraSpace = ["(", "."].includes(prev?.value ?? "") ? 0 : 1;
    if (line.length + value.length + extraSpace <= MAX_LINE_LENGTH) return;

    const selectAnchor = currentSelectAnchor();
    if (selectAnchor !== null) {
      newLineAt(selectAnchor + 4);
      return;
    }

    const clauseMode = clauseStack[clauseStack.length - 1];
    if (["where", "having", "on"].includes(clauseMode)) {
      newLineAt(clauseMode === "on" ? baseCol() + 26 : baseCol() + 8);
    }
  };
  const appendToken = (token, prev) => {
    const isCompoundOperatorContinuation = lowerValue(token) === "from" &&
      lowerValue(prev ?? { value: "" }) === "distinct";
    if (!isCompoundOperatorContinuation) maybeWrapBefore(token, prev);
    const value = displayToken(token);
    const prevValue = prev?.value ?? "";
    const prevLower = prev ? prev.value.toLowerCase() : "";
    const noSpaceBefore = [",", ".", ")", ";"].includes(value);
    const functionCall = value === "(" && prev?.type === "word" &&
      (FUNCTIONS.has(prevLower) || !KEYWORDS.has(prevLower));
    const noSpaceAfterPrev = ["(", "."].includes(prevValue);

    if (!hasContent() || noSpaceBefore || functionCall || noSpaceAfterPrev) {
      line += value;
    } else {
      line += " " + value;
    }
  };
  const popSelectAnchorAtCurrentDepth = () => {
    const top = selectAnchors[selectAnchors.length - 1];
    if (top && top.depth === parens.length) selectAnchors.pop();
  };
  const popClausesWhile = (names) => {
    while (clauseStack.length > 1 && names.includes(clauseStack[clauseStack.length - 1])) {
      if (clauseStack[clauseStack.length - 1] === "select") popSelectAnchorAtCurrentDepth();
      clauseStack.pop();
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = lowerValue(token);
    const next = nextMeaningful(tokens, i);
    const nextLower = next ? lowerValue(next) : "";
    const clauseMode = clauseStack[clauseStack.length - 1];

    if (token.type === "comment") {
      const indent = commentIndent();
      if (hasContent()) flushLine();
      line = " ".repeat(indent) + token.value;
      flushLine();
      line = " ".repeat(indent);
      previousToken = token;
      continue;
    }

    if (token.value === "(") {
      appendToken(token, previousToken);
      const prevLower = previousToken ? previousToken.value.toLowerCase() : "";
      const isFunction = previousToken?.type === "word" &&
        !["from", "join", "in", "values", "exists", "into"].includes(prevLower);
      parens.push({ col: line.length - 1, isFunction });
      previousToken = token;
      continue;
    }

    if (token.value === ")") {
      const closing = parens[parens.length - 1];
      if (closing && !closing.isFunction) {
        popClausesWhile(["select", "from", "join", "on", "where", "having", "group", "order", "limit", "offset"]);
      }
      appendToken(token, previousToken);
      parens.pop();
      previousToken = token;
      continue;
    }

    if (lower === "select") {
      if (hasContent() && !line.endsWith("(")) newLineAt(baseCol());
      else if (!hasContent()) line = " ".repeat(baseCol());
      appendToken(token, previousToken);
      selectAnchors.push({ anchor: line.length + 1, depth: parens.length });
      clauseStack.push("select");
      previousToken = token;
      continue;
    }

    if (lower === "from" && clauseMode !== "from" && !isDistinctFromOperator(tokens, i)) {
      if (clauseMode === "select") {
        clauseStack.pop();
        popSelectAnchorAtCurrentDepth();
      }
      newLineAt(baseCol());
      appendToken(token, previousToken);
      clauseStack.push("from");
      previousToken = token;
      continue;
    }

    if (lower === "where" || lower === "having") {
      popClausesWhile(["select", "from", "join", "on"]);
      newLineAt(baseCol());
      appendToken(token, previousToken);
      clauseStack.push(lower);
      previousToken = token;
      continue;
    }

    if ((lower === "group" || lower === "order") && nextLower === "by") {
      popClausesWhile(["select", "from", "join", "on", "where", "having"]);
      newLineAt(baseCol());
      appendToken(token, previousToken);
      i += 1;
      appendToken(tokens[i], token);
      clauseStack.push(lower);
      previousToken = tokens[i];
      continue;
    }

    if (["limit", "offset", "union"].includes(lower)) {
      popClausesWhile(["select", "from", "join", "on", "where", "having", "group", "order"]);
      newLineAt(baseCol());
      appendToken(token, previousToken);
      clauseStack.push(lower);
      previousToken = token;
      continue;
    }

    if (["left", "right", "inner", "full", "cross"].includes(lower) && nextLower === "join") {
      newLineAt(baseCol() + 9);
      appendToken(token, previousToken);
      i += 1;
      appendToken(tokens[i], token);
      clauseStack.push("join");
      previousToken = tokens[i];
      continue;
    }

    if (lower === "join") {
      newLineAt(baseCol() + 9);
      appendToken(token, previousToken);
      clauseStack.push("join");
      previousToken = token;
      continue;
    }

    if (lower === "on" && clauseMode === "join") {
      newLineAt(baseCol() + 19);
      appendToken(token, previousToken);
      clauseStack.push("on");
      previousToken = token;
      continue;
    }

    if (["and", "or"].includes(lower)) {
      const c = caseStack[caseStack.length - 1];
      if (["where", "having", "on"].includes(clauseMode)) {
        newLineAt(clauseMode === "on" ? baseCol() + 22 : baseCol() + 4);
        appendToken(token, previousToken);
        previousToken = token;
        continue;
      }
      if (c && c.multiline) {
        newLineAt(c.anchor + 8);
        appendToken(token, previousToken);
        previousToken = token;
        continue;
      }
    }

    if (lower === "case") {
      const top = selectAnchors[selectAnchors.length - 1];
      const inSelectList = top && top.depth === parens.length;
      appendToken(token, previousToken);
      caseStack.push({
        anchor: inSelectList ? top.anchor : (line.length - 4),
        multiline: !!inSelectList,
        depth: parens.length
      });
      previousToken = token;
      continue;
    }

    if (lower === "when") {
      const c = caseStack[caseStack.length - 1];
      if (c && c.multiline) newLineAt(c.anchor + 4);
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (lower === "then") {
      const c = caseStack[caseStack.length - 1];
      if (c && c.multiline && line.length > MAX_INLINE_CASE_LENGTH) newLineAt(c.anchor + 8);
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (lower === "else") {
      const c = caseStack[caseStack.length - 1];
      if (c && c.multiline) newLineAt(c.anchor + 4);
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (lower === "end") {
      caseStack.pop();
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (token.value === ",") {
      appendToken(token, previousToken);
      const top = selectAnchors[selectAnchors.length - 1];
      if (top && top.depth === parens.length) {
        newLineAt(top.anchor);
      } else if ((clauseMode === "group" || clauseMode === "order") && parens.length === 0) {
        newLineAt(baseCol() + 4);
      }
      previousToken = token;
      continue;
    }

    if (token.value === ";") {
      appendToken(token, previousToken);
      flushLine();
      clauseStack.length = 1;
      selectAnchors.length = 0;
      caseStack.length = 0;
      parens.length = 0;
      previousToken = token;
      continue;
    }

    appendToken(token, previousToken);
    previousToken = token;
  }

  if (line.trim()) flushLine();

  return alignAliasColumns(out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""));
}

function isAliasAlignmentBoundary(line) {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) return true;
  return /^(from|where|having|group by|order by|limit|offset|union|left join|right join|inner join|full join|cross join|join|on)\b/.test(trimmed);
}

function findAliasIndex(line) {
  const lower = line.toLowerCase();
  const index = lower.lastIndexOf(" as ");
  if (index < 0) return -1;

  const suffix = lower.slice(index + 4).trim();
  if (!suffix || /^(null|double|char|varchar|int|integer|bigint|decimal|date|datetime|timestamp)\b/.test(suffix)) {
    return -1;
  }
  if (!/[),]?$/.test(suffix)) return -1;
  return index;
}

function alignAliasRun(lines, start, end) {
  const candidates = [];
  for (let i = start; i < end; i += 1) {
    const index = findAliasIndex(lines[i]);
    if (index >= 0 && index <= MAX_ALIAS_ALIGNMENT_COLUMN) {
      candidates.push({ index: i, aliasIndex: index });
    }
  }
  if (candidates.length < 2) return;

  const maxAliasIndex = Math.max(...candidates.map((item) => item.aliasIndex));
  if (maxAliasIndex > MAX_ALIAS_ALIGNMENT_COLUMN) return;

  for (const item of candidates) {
    const line = lines[item.index];
    const before = line.slice(0, item.aliasIndex).replace(/\s+$/, "");
    const padding = maxAliasIndex - before.length + 1;
    if (padding > MAX_ALIAS_ALIGNMENT_PADDING) continue;

    const after = line.slice(item.aliasIndex).trimStart().replace(/^as\s+/i, "as ");
    lines[item.index] = before + " ".repeat(padding) + after;
  }
}

function alignAliasColumns(sql) {
  const lines = sql.split("\n");
  let start = 0;

  for (let i = 0; i <= lines.length; i += 1) {
    if (i === lines.length || isAliasAlignmentBoundary(lines[i])) {
      alignAliasRun(lines, start, i);
      start = i + 1;
    }
  }

  return lines.join("\n");
}

function cleanIdentifier(value) {
  return value.replace(/^["'`]+|["'`]+$/g, "");
}

function readIdentifier(tokens, index) {
  const parts = [];
  let i = index;

  while (tokens[i]) {
    const token = tokens[i];
    if (!["word", "quoted", "string"].includes(token.type)) break;
    parts.push(cleanIdentifier(token.value));
    if (tokens[i + 1]?.value === "." && ["word", "quoted", "string"].includes(tokens[i + 2]?.type)) {
      parts.push(".");
      i += 2;
      continue;
    }
    break;
  }

  return { name: parts.join(""), end: i };
}

function collectTables(tokens) {
  const tables = new Map();
  const aliases = new Map();

  const addTable = (tableName, alias) => {
    if (!tableName || tableName === "(") return;
    if (!tables.has(tableName)) tables.set(tableName, { name: tableName, aliases: new Set(), fields: new Set() });
    if (alias) {
      tables.get(tableName).aliases.add(alias);
      aliases.set(alias, tableName);
    }
    aliases.set(tableName, tableName);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const lower = lowerValue(tokens[i]);
    const previousLower = i > 0 ? lowerValue(tokens[i - 1]) : "";
    const isTableStarter = lower === "from" || lower === "join" || lower === "update" ||
      (lower === "into" && previousLower === "insert");

    if (!isTableStarter) continue;

    let j = i + 1;
    if (tokens[j]?.value === "(") continue;

    while (tokens[j]) {
      const table = readIdentifier(tokens, j);
      if (!table.name) break;
      j = table.end + 1;

      let alias = "";
      if (lowerValue(tokens[j]) === "as") j += 1;
      if (tokens[j] && ["word", "quoted", "string"].includes(tokens[j].type) && !RESERVED_ALIAS_STOP.has(lowerValue(tokens[j]))) {
        alias = cleanIdentifier(tokens[j].value);
        j += 1;
      }

      addTable(table.name, alias);
      if (tokens[j]?.value === ",") {
        j += 1;
        continue;
      }
      break;
    }
  }

  return { tables, aliases };
}

function collectOutputAliases(tokens) {
  const aliases = new Set();
  for (let i = 1; i < tokens.length; i += 1) {
    if (lowerValue(tokens[i - 1]) !== "as") continue;
    if (!["word", "quoted", "string"].includes(tokens[i].type)) continue;
    aliases.add(cleanIdentifier(tokens[i].value));
  }
  return aliases;
}

function isColumnContext(tokens, index) {
  const token = tokens[index];
  const prev = tokens[index - 1];
  const next = tokens[index + 1];
  const lower = lowerValue(token);

  if (KEYWORDS.has(lower) || FUNCTIONS.has(lower)) return false;
  if (lowerValue(prev ?? { value: "" }) === "as") return false;
  if (prev?.value === "." || next?.value === "." || next?.value === "(") return false;
  if (["string", "number", "comment"].includes(token.type)) return false;
  return ["word", "quoted"].includes(token.type);
}

function analyzeSql(sql) {
  const tokens = tokenize(sql);
  const { tables, aliases } = collectTables(tokens);
  const outputAliases = collectOutputAliases(tokens);
  const unknownFields = new Set();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!["word", "quoted", "string"].includes(token.type)) continue;

    if (tokens[i + 1]?.value === "." && ["word", "quoted", "string"].includes(tokens[i + 2]?.type)) {
      const owner = cleanIdentifier(token.value);
      const field = cleanIdentifier(tokens[i + 2].value);
      const tableName = aliases.get(owner);
      if (tableName && tables.has(tableName)) {
        tables.get(tableName).fields.add(field);
      } else if (field !== "*") {
        unknownFields.add(`${owner}.${field}`);
      }
      i += 2;
      continue;
    }

    if (isColumnContext(tokens, i)) {
      const field = cleanIdentifier(token.value);
      if (outputAliases.has(field)) continue;
      if (aliases.has(field) || RESERVED_ALIAS_STOP.has(field.toLowerCase())) continue;
      if (tables.size === 1) {
        const onlyTable = tables.values().next().value;
        onlyTable.fields.add(field);
      } else {
        unknownFields.add(field);
      }
    }
  }

  return {
    tables: Array.from(tables.values()).map((table) => ({
      name: table.name,
      aliases: Array.from(table.aliases),
      fields: Array.from(table.fields).sort()
    })),
    unknownFields: Array.from(unknownFields).sort()
  };
}
