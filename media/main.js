// MD Reader webview script. Renders Markdown with marked + DOMPurify + highlight.js +
// KaTeX + Mermaid, matching the standalone MD Reader web app's rendering rules, and
// talks back to the extension host for anything that touches the filesystem: opening
// links, resolving images, and saving task-checkbox edits.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const docEl = document.getElementById('doc');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let imageMap = {};
  let currentText = '';

  /* ---------------- marked setup (same extensions as the web app) ---------------- */
  const mathBlock = {
    name: 'mathBlock',
    level: 'block',
    start(src) { const m = src.match(/(^|\n)\$\$/); return m ? m.index + m[1].length : undefined; },
    tokenizer(src) {
      const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
      if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
    },
    renderer: (t) => `<div class="math math-display" data-tex="${encodeURIComponent(t.text)}">${esc(t.text)}</div>\n`,
  };
  const mathInline = {
    name: 'mathInline',
    level: 'inline',
    start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      let m = /^\$\$([^$]+?)\$\$/.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
      m = /^\$`([^`]+)`\$/.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
      m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
    },
    renderer: (t) => `<span class="math ${t.display ? 'math-display' : 'math-inline'}" data-tex="${encodeURIComponent(t.text)}">${esc(t.text)}</span>`,
  };

  marked.use({
    gfm: true,
    extensions: [mathBlock, mathInline],
    renderer: {
      code({ text, lang }) {
        const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
        if (language === 'mermaid') return `<div class="mermaid-block" data-src="${encodeURIComponent(text)}"></div>\n`;
        if (language === 'math') return `<div class="math math-display" data-tex="${encodeURIComponent(text)}">${esc(text)}</div>\n`;
        let body = esc(text);
        if (language && hljs.getLanguage(language)) {
          try { body = hljs.highlight(text, { language, ignoreIllegals: true }).value; } catch {}
        }
        return `<pre data-lang="${esc(language)}"><code class="hljs${language ? ' language-' + esc(language) : ''}">${body}</code></pre>\n`;
      },
    },
  });

  function splitFrontMatter(text) {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(text);
    if (!m) return { body: text, fm: null };
    const rows = [];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) rows.push([kv[1], kv[2]]);
      else if (rows.length && line.trim()) rows[rows.length - 1][1] += ' ' + line.trim();
    }
    return { body: text.slice(m[0].length), fm: rows };
  }

  /* ---------------- task checkboxes (list items + "[ ]"/"[x]" table cells) ---------------- */
  function convertCellTasks() {
    docEl.querySelectorAll('td, th').forEach((cell) => {
      const m = /^\[([ xX])\]$/.exec(cell.textContent.trim());
      if (!m || cell.children.length) return;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'cell-task';
      cb.checked = m[1] !== ' ';
      cell.textContent = ''; cell.append(cb); cell.classList.add('cell-task-cell');
    });
  }
  function taskBoxes() {
    return [...docEl.querySelectorAll('li input[type=checkbox], input.cell-task')].filter((cb) => {
      if (cb.classList.contains('cell-task')) return true;
      const p = cb.parentElement;
      if (p.firstElementChild !== cb) return false;
      if (p.tagName === 'LI') return true;
      return p.tagName === 'P' && p.parentElement.tagName === 'LI' && p.parentElement.firstElementChild === p;
    });
  }
  function onTaskClick(box) {
    const boxes = taskBoxes();
    const index = boxes.indexOf(box);
    // Capture every box's CURRENT state first — this is what the host cross-checks
    // against the live file text before trusting an edit (same states the file should
    // currently contain, assuming nothing else changed it since the last render).
    const renderedChecked = boxes.map((b) => b.checked);
    const checked = !renderedChecked[index]; // the value the user wants it to become
    box.checked = checked; // optimistic UI; a real render() replaces this once the host confirms
    box.disabled = true;
    vscode.postMessage({ type: 'toggleTask', renderedChecked, index, checked });
    // The host applies a WorkspaceEdit, which comes back through the normal
    // onDidChangeTextDocument -> 'update' message, re-rendering with the new state.
    // Re-enabling happens naturally on the next render.
  }

  // Delegated, once-only listener (not re-attached per render): a native checkbox's
  // actual clickable hit box in Chromium ignores CSS padding/width, so it stays exactly
  // as small as the drawn widget (~13px) — too small to click reliably. Listening on the
  // whole cell/list-item instead makes the entire row clickable, which is both easier to
  // hit and better UX (same pattern GitHub/GitLab task lists use).
  docEl.addEventListener('click', (e) => {
    const wrapper = e.target.closest('li.task, .cell-task-cell');
    if (!wrapper) return;
    const box = wrapper.matches('.cell-task-cell') ? wrapper.querySelector('input.cell-task') : wrapper.querySelector('input.task-box');
    if (!box || box.disabled) return;
    e.preventDefault();
    onTaskClick(box);
  });

  /* ---------------- rendering ---------------- */
  const ALERTS = {
    note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution',
    info: 'Info', danger: 'Danger', success: 'Success',
  };

  function render(text) {
    currentText = text;
    const { body, fm } = splitFrontMatter(text);
    let fmHtml = '';
    if (fm && fm.length) {
      fmHtml = `<details class="frontmatter"><summary>Metadata</summary><table><tbody>${fm
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</tbody></table></details>`;
    }
    let html;
    try { html = DOMPurify.sanitize(marked.parse(body)); }
    catch (e) { html = `<div class="doc-error">Failed to render: ${esc(e.message)}</div>`; }
    docEl.innerHTML = fmHtml + html;
    enhance();
    renderMath();
    renderMermaid();
  }

  function enhance() {
    const seen = new Map();
    docEl.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
      let id = h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
      const n = seen.get(id) || 0; seen.set(id, n + 1);
      if (n) id += '-' + n;
      h.id = id;
      const a = document.createElement('a');
      a.className = 'anchor'; a.href = '#' + id; a.textContent = '#'; a.setAttribute('aria-hidden', 'true');
      h.prepend(a);
    });

    docEl.querySelectorAll('blockquote').forEach((bq) => {
      const p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      const m = /^\s*\[!(\w+)\][ \t]*([^\n<]*)(?:\n|<br>|$)/i.exec(p.innerHTML);
      const kind = m && ALERTS[m[1].toLowerCase()] ? m[1].toLowerCase() : null;
      if (!kind) return;
      p.innerHTML = p.innerHTML.slice(m[0].length);
      if (!p.innerHTML.trim()) p.remove();
      const div = document.createElement('div');
      div.className = 'alert alert-' + kind;
      div.innerHTML = `<div class="alert-title">${m[2].trim() || ALERTS[kind]}</div>`;
      div.append(...bq.childNodes);
      bq.replaceWith(div);
    });

    docEl.querySelectorAll('table').forEach((t) => {
      if (t.parentElement.classList.contains('table-wrap')) return;
      const w = document.createElement('div'); w.className = 'table-wrap';
      t.replaceWith(w); w.append(t);
    });

    convertCellTasks();
    taskBoxes().forEach((cb) => {
      cb.classList.add('task-box');
      cb.disabled = false; // marked renders GFM task checkboxes with disabled="" by default
      const li = cb.closest('li');
      if (li) li.classList.add('task');
    });

    docEl.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      const wrap = document.createElement('div'); wrap.className = 'code-block';
      const head = document.createElement('div'); head.className = 'code-head';
      const label = document.createElement('span'); label.textContent = pre.dataset.lang || 'text';
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Copy';
      btn.onclick = async () => {
        try { await navigator.clipboard.writeText(code.textContent); btn.textContent = 'Copied'; }
        catch { btn.textContent = 'Failed'; }
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      };
      head.append(label, btn);
      pre.replaceWith(wrap); wrap.append(head, pre);
    });

    docEl.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href.startsWith('#')) { scrollToAnchor(decodeURIComponent(href.slice(1))); return; }
        vscode.postMessage({ type: 'openLink', href });
      });
    });

    docEl.querySelectorAll('img[src]').forEach((img) => {
      const raw = img.getAttribute('src');
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return;
      const mapped = imageMap[raw] || imageMap[decodeURIComponent(raw)];
      if (mapped) { img.src = mapped; img.addEventListener('click', () => openLightbox(mapped)); img.style.cursor = 'zoom-in'; }
      else { img.alt = `[missing image: ${raw}]`; img.title = 'File not found: ' + raw; img.classList.add('missing'); }
    });
  }

  function scrollToAnchor(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start' });
  }

  function openLightbox(src) {
    const lb = document.getElementById('lightbox');
    lb.querySelector('img').src = src;
    lb.classList.add('open');
  }
  document.getElementById('lightbox').addEventListener('click', (e) => e.currentTarget.classList.remove('open'));

  function renderMath() {
    docEl.querySelectorAll('.math[data-tex]').forEach((el) => {
      try { katex.render(decodeURIComponent(el.dataset.tex), el, { displayMode: el.classList.contains('math-display'), throwOnError: false }); }
      catch (e) { el.title = e.message; }
    });
  }

  let mermaidSeq = 0, mermaidInit = false;
  async function renderMermaid() {
    const blocks = docEl.querySelectorAll('.mermaid-block');
    if (!blocks.length || !window.mermaid) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
    mermaidInit = true;
    for (const el of blocks) {
      const src = decodeURIComponent(el.dataset.src);
      const id = 'mmd-' + (++mermaidSeq);
      try {
        const { svg } = await mermaid.render(id, src);
        el.classList.remove('error');
        el.innerHTML = svg;
      } catch (e) {
        document.getElementById('d' + id)?.remove();
        document.getElementById(id)?.remove();
        el.classList.add('error');
        el.innerHTML = `<div>Mermaid error: ${esc((e && e.message) || e)}</div><pre>${esc(src)}</pre>`;
      }
    }
  }

  /* ---------------- theme: VS Code sets vscode-light/vscode-dark/vscode-high-contrast on <body> ---------------- */
  function isDark() {
    return document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  }
  function applyTheme() {
    const dark = isDark();
    document.getElementById('hljs-light').disabled = dark;
    document.getElementById('hljs-dark').disabled = !dark;
    if (mermaidInit) renderMermaid();
  }
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyTheme();

  /* ---------------- toolbar ---------------- */
  document.getElementById('btn-wide').addEventListener('click', () => document.documentElement.classList.toggle('wide'));
  document.getElementById('btn-export').addEventListener('click', () => requestExport());

  function requestExport() {
    const clone = docEl.cloneNode(true);
    clone.querySelectorAll('.code-head button').forEach((b) => b.remove());
    const styles = [...document.querySelectorAll('link[rel=stylesheet]')]
      .filter((l) => !l.disabled)
      .map((l) => `<link rel="stylesheet" href="${l.href}">`)
      .join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Exported from MD Reader</title>${styles}
<style>body{max-width:900px;margin:40px auto;padding:0 20px;font:16px/1.6 -apple-system,sans-serif;color:#1f2328;background:#fff}
.anchor{display:none}.code-head button{display:none}</style></head><body class="markdown-body">${clone.innerHTML}</body></html>`;
    vscode.postMessage({ type: 'exportHtmlResult', html });
  }

  /* ---------------- messages from the extension host ---------------- */
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'update') {
      imageMap = msg.images || {};
      if (msg.text !== currentText) render(msg.text);
    } else if (msg.type === 'scrollTo') {
      scrollToAnchor(msg.anchor);
    } else if (msg.type === 'scrollToIndex') {
      // From the "On This Page" sidebar view (outline.ts) — it only knows headings by
      // position, since it parses the file text server-side rather than this DOM.
      const h = docEl.querySelectorAll('h1,h2,h3,h4,h5,h6')[msg.index];
      if (h) h.scrollIntoView({ block: 'start' });
    } else if (msg.type === 'config') {
      document.documentElement.style.setProperty('--font-size', msg.fontSize + 'px');
      document.documentElement.classList.toggle('wide', msg.lineWidth === 'wide');
    } else if (msg.type === 'requestExportHtml') {
      requestExport();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
