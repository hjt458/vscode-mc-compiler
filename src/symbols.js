'use strict';

/**
 * Lexical symbols for `.mc` files: function declarations, `MODULE("...")`, and
 * the tags a script indexes by. No compiler involved — this is what powers the
 * Outline view and Ctrl+Click, so it stays fast and works even when the JDK or
 * the mod sources are missing.
 *
 * Everything is line/column (0-based) over the original text so it can be fed
 * straight into `vscode.Range` / `vscode.Location`.
 */

const WORD_RE = /[\w\u4e00-\u9fa5]/;

/** Control-flow heads that look like `type name(` but are not declarations. */
const NOT_A_DECLARATION = new Set([
  'if', 'for', 'while', 'switch', 'return', 'else', 'do', 'case', 'catch',
]);

/**
 * Blank out comments and string contents while keeping every character offset
 * intact, so regexes over the result still report positions in the real file.
 */
function mask(source) {
  const out = source.split('');
  let inBlock = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < out.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inBlock) {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        inBlock = false;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        out[i] = ' ';
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out[i] = ' ';
        continue;
      }
      if (ch === '"') {
        inString = false;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 1;
      inBlock = true;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < out.length && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
  }
  return out.join('');
}

/** Split into `{ text, start }` lines, where `start` is the line's offset. */
function lines(masked) {
  const result = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i += 1) {
    if (i === masked.length || masked[i] === '\n') {
      result.push({ text: masked.slice(start, i), start });
      start = i + 1;
    }
  }
  return result;
}

/**
 * `MODULE("名")` — the module this script registers. The name lives inside a
 * string, so it is read from the original text while the position comes from
 * the masked text.
 */
function findModule(masked, source) {
  for (const line of lines(masked)) {
    const match = /^[ \t]*MODULE[ \t]*\(/.exec(line.text);
    if (match === null) continue;
    const open = line.start + match[0].length - 1;
    const close = masked.indexOf(')', open);
    if (close < 0) return undefined;
    const name = source
      .slice(open + 1, close)
      .trim()
      .replace(/^"|"$/g, '')
      .trim();
    if (name === '') return undefined;
    const at = source.indexOf(name, open);
    return { name, kind: 'module', offset: at < 0 ? open : at };
  }
  return undefined;
}

/**
 * Every `type name(` declaration, plus `RunLoop` (which is just a function but
 * deserves the entry-point kind in the Outline).
 */
function findFunctions(masked) {
  const found = [];
  let offset = 0;

  for (const line of lines(masked)) {
    const trimmed = line.text.trimStart();
    const lead = line.text.length - trimmed.length;
    const head = /^([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/.exec(trimmed);
    if (head !== null && NOT_A_DECLARATION.has(head[1])) {
      offset += line.text.length + 1;
      continue;
    }

    const match = /^(?:(?:[A-Za-z_][\w:<>,.[\]]*)[ \t]+)+([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)[ \t]*\(/.exec(
      trimmed,
    );
    if (match === null) {
      offset += line.text.length + 1;
      continue;
    }
    const name = match[1];
    const index = trimmed.indexOf(name, match.index);
    found.push({
      name,
      kind: name === 'RunLoop' ? 'entry' : 'function',
      offset: line.start + lead + Math.max(0, index),
      line: offset,
    });

    offset += line.text.length + 1;
  }
  return found;
}

/** All symbols worth showing in the Outline, in document order. */
function collectSymbols(source) {
  const masked = mask(source);
  const symbols = [];

  const module = findModule(masked, source);
  if (module !== undefined) {
    symbols.push({ name: module.name, kind: 'module', offset: module.offset });
  }
  for (const fn of findFunctions(masked)) {
    symbols.push({ name: fn.name, kind: fn.kind, offset: fn.offset });
  }
  symbols.sort((a, b) => a.offset - b.offset);
  return symbols;
}

/** Convert a character offset into 0-based line/character. */
function positionAt(source, offset) {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/** The identifier (ASCII or Chinese) covering `character` on `lineText`. */
function wordAt(lineText, character) {
  if (lineText === undefined) return undefined;
  const index = Math.min(Math.max(character, 0), Math.max(lineText.length - 1, 0));
  if (!WORD_RE.test(lineText[index] ?? '')) return undefined;

  let start = index;
  let end = index;
  while (start > 0 && WORD_RE.test(lineText[start - 1])) start -= 1;
  while (end + 1 < lineText.length && WORD_RE.test(lineText[end + 1])) end += 1;
  return { word: lineText.slice(start, end + 1), start, end };
}

/** Find the declaration of `name` inside one source text, if any. */
function findDefinition(source, name) {
  const masked = mask(source);
  const module = findModule(masked, source);
  if (module !== undefined && module.name === name) {
    return { ...positionAt(source, module.offset), name };
  }
  for (const fn of findFunctions(masked)) {
    if (fn.name === name) {
      return { ...positionAt(source, fn.offset), name };
    }
  }
  return undefined;
}

/** End of the body starting at `fromLine`, by brace matching (best effort). */
function bodyEnd(source, fromLine) {
  const masked = mask(source);
  const all = lines(masked);
  let depth = 0;
  let started = false;
  for (let i = fromLine; i < all.length; i += 1) {
    for (const ch of all[i].text) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth <= 0) return i;
      }
    }
    if (!started && i > fromLine + 1) return fromLine;
  }
  return Math.max(fromLine, all.length - 1);
}

module.exports = {
  bodyEnd,
  collectSymbols,
  findDefinition,
  findFunctions,
  findModule,
  mask,
  positionAt,
  wordAt,
};
