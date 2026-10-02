// Finds the exact character to flip for a Markdown task checkbox, and cross-checks
// that finding against marked's own parser before allowing an edit. This mirrors the
// safety design of the standalone MD Reader web app (ReadMDFiles/index.html), ported
// to run once in the extension host instead of per-click in a browser.
import { marked } from 'marked';

export const CELL_TASK = /^\[([ xX])\]$/;

export function splitFrontMatterBody(text: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Offsets (into the *whole* file text) of the character between the brackets of
 *  every task checkbox: list items ("- [ ] x") and table cells whose entire content
 *  is "[ ]" / "[x]". Skips YAML front matter and fenced code blocks. */
export function findTaskOffsets(text: string): number[] {
  const out: number[] = [];
  const fm = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
  let pos = fm ? fm[0].length : 0;
  let fence: string | null = null;
  const prefix = /^([ \t]*(?:>[ \t]?)*[ \t]*)/;
  const listTask = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;

  for (const raw of text.slice(pos).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // tolerate CRLF files
    const body = line.slice(prefix.exec(line)![1].length);
    const f = /^(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
    } else if (f) {
      fence = f[1];
    } else {
      const m = listTask.exec(line);
      if (m) {
        out.push(pos + m[0].length - 2);
      } else if (body.includes('|')) {
        // Table row: find cells whose trimmed content is exactly "[ ]" or "[x]".
        const start = line.length - body.length;
        let cellStart = 0;
        for (let i = 0; i <= body.length; i++) {
          if (i < body.length && (body[i] !== '|' || body[i - 1] === '\\')) continue;
          const cell = body.slice(cellStart, i);
          if (CELL_TASK.test(cell.trim())) out.push(pos + start + cellStart + cell.indexOf('[') + 1);
          cellStart = i + 1;
        }
      }
    }
    pos += raw.length + 1;
  }
  return out;
}

/** Task states (true = checked) according to marked's own parser, in document order:
 *  list tasks first in reading order, then table-cell tasks. Used only as a
 *  cross-check that findTaskOffsets() agrees with how marked actually parses the file. */
export function lexTasks(body: string): boolean[] {
  const out: boolean[] = [];
  const walk = (tokens: any[] | undefined) => {
    for (const t of tokens || []) {
      if (t.type === 'list') {
        for (const item of t.items) {
          if (item.task) out.push(!!item.checked);
          walk(item.tokens);
        }
      } else if (t.type === 'table') {
        for (const cell of [...t.header, ...t.rows.flat()]) {
          const m = CELL_TASK.exec(cell.text.trim());
          if (m) out.push(m[1] !== ' ');
        }
      } else if (t.tokens) {
        walk(t.tokens);
      }
    }
  };
  walk(marked.lexer(body) as any[]);
  return out;
}

export interface TaskCheckResult {
  /** Offsets safe to toggle, in document order. Empty if the file isn't editable. */
  offsets: number[];
  /** Why editing is disabled, or undefined if it's fine. */
  reason?: string;
}

/** Decides whether a file's tasks can be safely toggled: the regex scan, marked's
 *  parser, and the supplied rendered-checkbox states must all agree, exactly like the
 *  web app's setupTasks(). If anything disagrees, editing is refused for that file. */
export function checkTasksEditable(text: string, renderedChecked: boolean[]): TaskCheckResult {
  const offsets = findTaskOffsets(text);
  let lex: boolean[];
  try {
    lex = lexTasks(splitFrontMatterBody(text));
  } catch {
    return { offsets: [], reason: "This file's checkboxes can't be parsed safely" };
  }
  const ok =
    offsets.length === renderedChecked.length &&
    lex.length === renderedChecked.length &&
    renderedChecked.every((c, i) => c === lex[i] && c === (text[offsets[i]] !== ' '));
  if (!ok) return { offsets: [], reason: "This file's checkboxes can't be matched to its text safely" };
  return { offsets };
}
