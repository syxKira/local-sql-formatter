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

const LONG_EXPRESSION_OPERATORS = new Set(["*", "/", "+"]);

const RESERVED_ALIAS_STOP = new Set([
  "on", "where", "join", "left", "right", "inner", "outer", "full", "cross",
  "group", "order", "having", "limit", "union", "set", "values", "using", "and",
  "or", "when", "then", "else", "end"
]);

const MAX_ALIAS_ALIGNMENT_COLUMN = 106;
const MAX_BOOLEAN_INLINE_LENGTH = 96;
const MAX_CASE_BOOLEAN_INLINE_LENGTH = 80;
const MAX_CASE_COMPOUND_THEN_PREFIX = 60;
const MAX_INLINE_CASE_LENGTH = 100;
const MAX_CASE_PREFIX_LENGTH = 40;
const MAX_INLINE_LIST_LENGTH = 76;
const MAX_LINE_LENGTH = 142;
const MAX_JOIN_INDENT = MAX_LINE_LENGTH - 73;
let activeWideCharacterWidth = 2;

self.addEventListener("message", (event) => {
  const { id, type, sql, displayMetrics } = event.data;
  try {
    const measuredWideCharacterWidth = Number(displayMetrics?.wideCharacterWidth);
    if (Number.isFinite(measuredWideCharacterWidth)) {
      activeWideCharacterWidth = Math.min(Math.max(measuredWideCharacterWidth, 1), 2);
    }
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

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function displayWidth(value) {
  let width = 0;
  let wideCharacterCount = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
      /\p{Mark}/u.test(character)
    ) {
      continue;
    }
    if (isWideCodePoint(codePoint)) wideCharacterCount += 1;
    else width += 1;
  }

  return width + Math.round(wideCharacterCount * activeWideCharacterWidth);
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
  const pendingJoinIndents = [];
  let previousToken = null;
  let conditionBreakCol = null;

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
  const fallbackBooleanCol = () => {
    const selectAnchor = currentSelectAnchor();
    if (selectAnchor !== null) return selectAnchor + 4;

    const preferred = baseCol() + 4;
    const indent = lineIndent();
    return indent > 0 ? Math.min(indent, preferred) : preferred;
  };
  const currentParen = () => parens[parens.length - 1] ?? null;
  const listBreakCol = (paren) => {
    if (paren.listBreakCol !== null && paren.listBreakCol !== undefined) return paren.listBreakCol;

    const indent = lineIndent();
    const byParen = paren.col + 1;
    const byIndent = indent + 4;
    const col = byParen > MAX_LINE_LENGTH - 32 ? byIndent : Math.max(byParen, byIndent);
    paren.listBreakCol = col;
    return col;
  };
  const wrapCurrentList = (paren) => {
    paren.multilineList = true;
    newLineAt(listBreakCol(paren));
  };
  const expressionBreakCol = () => {
    const preferred = baseCol() + 4;
    const byIndent = lineIndent() + 4;
    return preferred > MAX_LINE_LENGTH - 32 ? byIndent : Math.max(preferred, byIndent);
  };
  const joinBreakCol = () => Math.min(baseCol() + 9, MAX_JOIN_INDENT);
  const isQualifiedIdentifierToken = (token) => ["word", "quoted", "string"].includes(token?.type);
  const qualifiedIdentifierLength = (index) => {
    let length = displayWidth(displayToken(tokens[index]));
    let cursor = index;

    while (tokens[cursor + 1]?.value === "." && isQualifiedIdentifierToken(tokens[cursor + 2])) {
      length += 1 + displayWidth(displayToken(tokens[cursor + 2]));
      cursor += 2;
    }

    return length;
  };
  const expandCase = (c, offset) => {
    c.multiline = true;
    newLineAt(c.anchor + offset);
  };
  const maybeWrapBefore = (token, prev, index = -1) => {
    if (!hasContent()) return;
    if ([",", ".", ")", ";"].includes(token.value)) return;
    if (prev?.value === ".") return;
    if (lowerValue(prev ?? { value: "" }) === "as") return;

    const value = displayToken(token);
    const extraSpace = ["(", "."].includes(prev?.value ?? "") ? 0 : 1;
    const valueLength = index >= 0 && tokens[index + 1]?.value === "."
      ? qualifiedIdentifierLength(index)
      : displayWidth(value);
    if (LONG_EXPRESSION_OPERATORS.has(token.value) && displayWidth(line) >= MAX_INLINE_LIST_LENGTH) {
      newLineAt(expressionBreakCol());
      return;
    }
    if (displayWidth(line) + valueLength + extraSpace <= MAX_LINE_LENGTH) return;

    const paren = currentParen();
    if (paren && !paren.isFunction) {
      wrapCurrentList(paren);
      return;
    }
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
  const appendToken = (token, prev, index = -1) => {
    const isCompoundOperatorContinuation = lowerValue(token) === "from" &&
      lowerValue(prev ?? { value: "" }) === "distinct";
    if (!isCompoundOperatorContinuation) maybeWrapBefore(token, prev, index);
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
      parens.push({ col: displayWidth(line) - 1, isFunction, listBreakCol: null, multilineList: false });
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
      selectAnchors.push({ anchor: displayWidth(line) + 1, depth: parens.length });
      clauseStack.push("select");
      previousToken = token;
      continue;
    }

    if (lower === "from" && clauseMode !== "from" && !isDistinctFromOperator(tokens, i)) {
      if (clauseMode === "select") {
        clauseStack.pop();
        popSelectAnchorAtCurrentDepth();
      }
      if (parens.length === 0) conditionBreakCol = null;
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
      conditionBreakCol = baseCol() + 4;
      clauseStack.push(lower);
      previousToken = token;
      continue;
    }

    if ((lower === "group" || lower === "order") && nextLower === "by") {
      popClausesWhile(["select", "from", "join", "on", "where", "having"]);
      if (parens.length === 0) conditionBreakCol = null;
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
      if (parens.length === 0) conditionBreakCol = null;
      newLineAt(baseCol());
      appendToken(token, previousToken);
      clauseStack.push(lower);
      previousToken = token;
      continue;
    }

    if (["left", "right", "inner", "full", "cross"].includes(lower) && nextLower === "join") {
      newLineAt(joinBreakCol());
      if (lower !== "cross") pendingJoinIndents.push(lineIndent());
      appendToken(token, previousToken);
      i += 1;
      appendToken(tokens[i], token);
      clauseStack.push("join");
      previousToken = tokens[i];
      continue;
    }

    if (lower === "join") {
      newLineAt(joinBreakCol());
      pendingJoinIndents.push(lineIndent());
      appendToken(token, previousToken);
      clauseStack.push("join");
      previousToken = token;
      continue;
    }

    if (lower === "on" && (clauseMode === "join" || pendingJoinIndents.length) && !caseStack.length) {
      const joinIndent = pendingJoinIndents.length ? pendingJoinIndents.pop() : null;
      const onIndent = joinIndent !== null ? joinIndent + 4 : (hasContent() ? lineIndent() + 4 : baseCol() + 4);
      newLineAt(onIndent);
      appendToken(token, previousToken);
      conditionBreakCol = onIndent + 4;
      clauseStack.push("on");
      previousToken = token;
      continue;
    }

    if (["and", "or"].includes(lower)) {
      const c = caseStack[caseStack.length - 1];
      if (["where", "having", "on"].includes(clauseMode)) {
        conditionBreakCol = clauseMode === "on" ? (conditionBreakCol ?? lineIndent() + 4) : baseCol() + 4;
        newLineAt(conditionBreakCol);
        appendToken(token, previousToken);
        previousToken = token;
        continue;
      }
      if (c && c.multiline) {
        if (displayWidth(line) >= MAX_CASE_BOOLEAN_INLINE_LENGTH) newLineAt(c.anchor + 8);
        appendToken(token, previousToken);
        previousToken = token;
        continue;
      }
      if (conditionBreakCol !== null) {
        newLineAt(conditionBreakCol);
        appendToken(token, previousToken);
        previousToken = token;
        continue;
      }
      if (displayWidth(line) >= MAX_BOOLEAN_INLINE_LENGTH) {
        newLineAt(conditionBreakCol ?? fallbackBooleanCol());
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
        anchor: inSelectList ? top.anchor : (displayWidth(line) - 4),
        multiline: !!inSelectList,
        depth: parens.length
      });
      previousToken = token;
      continue;
    }

    if (lower === "when") {
      const c = caseStack[caseStack.length - 1];
      if (c && (c.multiline || displayWidth(line) >= MAX_CASE_PREFIX_LENGTH)) expandCase(c, 4);
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (lower === "then") {
      const c = caseStack[caseStack.length - 1];
      let resultIndex = i + 1;
      while (tokens[resultIndex] && tokens[resultIndex].type === "comment") resultIndex += 1;
      const resultToken = tokens[resultIndex];
      const afterResult = resultToken ? nextMeaningful(tokens, resultIndex) : null;
      const resultLower = lowerValue(resultToken ?? { value: "" });
      const simpleResultWord = resultToken?.type === "word" &&
        (!KEYWORDS.has(resultLower) || ["false", "null", "true"].includes(resultLower));
      const simpleThenResult = resultToken &&
        (["number", "quoted", "string"].includes(resultToken.type) || simpleResultWord) &&
        !["(", "."].includes(afterResult?.value ?? "");
      const thenLength = displayWidth(line) + (hasContent() ? 1 : 0) + displayWidth(displayToken(token));
      const shortThenResultFits = simpleThenResult &&
        thenLength + 1 + displayWidth(displayToken(resultToken)) <= MAX_LINE_LENGTH;
      if (c && displayWidth(line) >= MAX_INLINE_CASE_LENGTH && !shortThenResultFits) {
        expandCase(c, 8);
      } else if (c && !shortThenResultFits && displayWidth(line) >= MAX_CASE_COMPOUND_THEN_PREFIX) {
        expandCase(c, 8);
      }
      appendToken(token, previousToken);
      previousToken = token;
      continue;
    }

    if (lower === "else") {
      const c = caseStack[caseStack.length - 1];
      if (c && c.multiline) expandCase(c, 4);
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
      const paren = currentParen();
      if (top && top.depth === parens.length) {
        newLineAt(top.anchor);
      } else if ((clauseMode === "group" || clauseMode === "order") && parens.length === 0) {
        newLineAt(baseCol() + 4);
      } else if (paren && !paren.isFunction && (paren.multilineList || displayWidth(line) >= MAX_INLINE_LIST_LENGTH)) {
        wrapCurrentList(paren);
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
      pendingJoinIndents.length = 0;
      conditionBreakCol = null;
      previousToken = token;
      continue;
    }

    appendToken(token, previousToken, i);
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

function readAliasEntry(line, index) {
  const aliasIndex = findAliasIndex(line);
  if (aliasIndex < 0) return null;
  const before = line.slice(0, aliasIndex).replace(/\s+$/, "");
  const after = line.slice(aliasIndex).trimStart().replace(/^as\s+/i, "as ");

  return {
    index,
    aliasIndex,
    aliasDisplayIndex: displayWidth(line.slice(0, aliasIndex)),
    before,
    beforeWidth: displayWidth(before),
    after,
    afterWidth: displayWidth(after)
  };
}

function findAliasExpressionBreaks(value) {
  const lower = value.toLowerCase();
  const candidates = [];
  let quote = "";

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") {
        if (value[i + 1] === quote) i += 1;
        else quote = "";
      }
      continue;
    }

    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }

    if (lower.startsWith(" else ", i)) {
      candidates.push({ prefixEnd: i, tailStart: i + 1, priority: 3 });
      continue;
    }
    if (char === ",") {
      candidates.push({ prefixEnd: i + 1, tailStart: i + 1, priority: 2 });
      continue;
    }
    if (lower.startsWith(" and ", i) || lower.startsWith(" or ", i)) {
      candidates.push({ prefixEnd: i, tailStart: i + 1, priority: 1 });
    }
  }

  return candidates.sort((a, b) => b.priority - a.priority || b.prefixEnd - a.prefixEnd);
}

function wrapAliasExpression(item, targetAliasIndex) {
  const leadingIndent = item.before.length - item.before.trimStart().length;
  const continuationIndent = leadingIndent + 4;

  for (const candidate of findAliasExpressionBreaks(item.before)) {
    const prefix = item.before.slice(0, candidate.prefixEnd).replace(/\s+$/, "");
    const tail = item.before.slice(candidate.tailStart).trim();
    const tailWidth = displayWidth(tail);
    if (tailWidth < 8) continue;

    const tailEnd = continuationIndent + tailWidth;
    const padding = targetAliasIndex - tailEnd + 1;
    if (displayWidth(prefix) > MAX_LINE_LENGTH || padding <= 0) continue;

    const continuation = " ".repeat(continuationIndent) + tail + " ".repeat(padding) + item.after;
    if (displayWidth(continuation) <= MAX_LINE_LENGTH) return [prefix, continuation];
  }

  return null;
}

function alignAliasRun(lines) {
  const entries = lines.map(readAliasEntry).filter(Boolean);
  const hasOverlongAlias = entries.some((item) => item.beforeWidth + 1 + item.afterWidth > MAX_LINE_LENGTH);
  if (entries.length < 2 && !hasOverlongAlias) return lines;

  const inlineEntries = entries.filter((item) => item.aliasDisplayIndex <= MAX_ALIAS_ALIGNMENT_COLUMN);
  const requestedAliasIndex = inlineEntries.length
    ? Math.max(...inlineEntries.map((item) => item.aliasDisplayIndex))
    : Math.min(Math.max(...entries.map((item) => item.aliasDisplayIndex)), MAX_ALIAS_ALIGNMENT_COLUMN);
  const targetAliasIndex = Math.min(requestedAliasIndex, MAX_ALIAS_ALIGNMENT_COLUMN);
  const entryByIndex = new Map(entries.map((item) => [item.index, item]));
  const result = [];

  for (let i = 0; i < lines.length; i += 1) {
    const item = entryByIndex.get(i);
    if (!item) {
      result.push(lines[i]);
      continue;
    }

    const entryTargetAliasIndex = Math.min(
      targetAliasIndex,
      Math.max(0, MAX_LINE_LENGTH - item.afterWidth - 1)
    );
    const padding = entryTargetAliasIndex - item.beforeWidth + 1;
    const alignedLength = item.beforeWidth + padding + item.afterWidth;
    const canAlignInline = padding > 0 &&
      alignedLength <= MAX_LINE_LENGTH;

    if (canAlignInline) {
      result.push(item.before + " ".repeat(padding) + item.after);
      continue;
    }

    const wrappedExpression = wrapAliasExpression(item, entryTargetAliasIndex);
    if (wrappedExpression) {
      result.push(...wrappedExpression);
      continue;
    }

    const naturalLine = item.before + " " + item.after;
    if (displayWidth(naturalLine) <= MAX_LINE_LENGTH) {
      result.push(naturalLine);
      continue;
    }

    const rightmostAliasIndent = Math.min(
      item.beforeWidth + 1,
      MAX_LINE_LENGTH - item.afterWidth
    );
    const aliasLine = " ".repeat(Math.max(entryTargetAliasIndex + 1, rightmostAliasIndent)) + item.after;
    if (item.beforeWidth > 0 && item.beforeWidth <= MAX_LINE_LENGTH && displayWidth(aliasLine) <= MAX_LINE_LENGTH) {
      result.push(item.before);
      result.push(aliasLine);
      continue;
    }

    result.push(lines[i]);
  }

  return result;
}

function startsNestedSelectEntry(line) {
  return /^\s*(?:from|left join|right join|inner join|full join|cross join|join)\s+\(\s*select\b/i.test(line) &&
    findAliasIndex(line) >= 0;
}

function alignAliasColumns(sql) {
  const lines = sql.split("\n");
  const result = [];
  let run = [];

  for (const line of lines) {
    if (isAliasAlignmentBoundary(line)) {
      result.push(...alignAliasRun(run));
      run = [];
      if (startsNestedSelectEntry(line)) run.push(line);
      else result.push(line);
    } else {
      run.push(line);
    }
  }
  result.push(...alignAliasRun(run));

  return result.join("\n");
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
