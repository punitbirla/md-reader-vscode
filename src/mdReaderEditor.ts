import * as vscode from 'vscode';
import * as path from 'path';
import { checkTasksEditable } from './taskEdit';

// One entry per open preview tab.
interface OpenPreview {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
}

function nonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

export class MdReaderEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'mdReader.preview';

  // The preview VS Code currently considers "active" (focused). Commands like
  // "View Source" act on this one.
  private static active: OpenPreview | undefined;
  private readonly previews = new Set<OpenPreview>();

  // Lets the "On This Page" outline view (outline.ts) know when to re-read headings:
  // fires on tab switch, on edits to the active document, and with `undefined` when no
  // MD Reader preview is active at all.
  private static readonly activeChangedEmitter = new vscode.EventEmitter<vscode.TextDocument | undefined>();
  static readonly onActiveChanged = MdReaderEditorProvider.activeChangedEmitter.event;
  private static setActive(entry: OpenPreview | undefined): void {
    MdReaderEditorProvider.active = entry;
    MdReaderEditorProvider.activeChangedEmitter.fire(entry?.document);
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  static getActiveDocument(): vscode.TextDocument | undefined {
    return MdReaderEditorProvider.active?.document;
  }

  static getActivePanel(): vscode.WebviewPanel | undefined {
    return MdReaderEditorProvider.active?.panel;
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const entry: OpenPreview = { panel: webviewPanel, document };
    this.previews.add(entry);
    if (webviewPanel.active) MdReaderEditorProvider.setActive(entry);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(document.uri),
    };
    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    const postDocument = async () => {
      const text = document.getText();
      webviewPanel.webview.postMessage({
        type: 'update',
        text,
        images: await this.resolveImageUris(document.uri, text, webviewPanel.webview),
      });
    };

    // Re-render on every edit (debounced) so the preview tracks unsaved changes too,
    // not just what's on disk.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        postDocument();
        if (MdReaderEditorProvider.active === entry) MdReaderEditorProvider.activeChangedEmitter.fire(document);
      }, 150);
    });

    const viewStateSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) MdReaderEditorProvider.setActive(entry);
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdReader')) webviewPanel.webview.postMessage({ type: 'config', ...this.config() });
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          webviewPanel.webview.postMessage({ type: 'config', ...this.config() });
          await postDocument();
          break;
        case 'setOutlineVisible':
          await this.context.globalState.update('outlineVisible', !!msg.visible);
          break;
        case 'toggleTask':
          await this.toggleTask(document, msg.renderedChecked, msg.index, msg.checked);
          break;
        case 'openLink':
          await this.openLink(document.uri, msg.href, webviewPanel.viewColumn);
          break;
        case 'exportHtmlResult':
          await this.saveExportedHtml(document.uri, msg.html);
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      viewStateSub.dispose();
      configSub.dispose();
      this.previews.delete(entry);
      if (MdReaderEditorProvider.active === entry) MdReaderEditorProvider.setActive(undefined);
    });
  }

  requestExport(panel: vscode.WebviewPanel): void {
    panel.webview.postMessage({ type: 'requestExportHtml' });
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration('mdReader');
    return {
      fontSize: cfg.get<number>('fontSize', 16),
      lineWidth: cfg.get<string>('lineWidth', 'normal'),
      // Remembered across files and sessions (the in-page outline's show/hide toggle).
      outlineVisible: this.context.globalState.get<boolean>('outlineVisible', true),
    };
  }

  private resourceRoots(docUri: vscode.Uri): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    const folder = vscode.workspace.getWorkspaceFolder(docUri);
    if (folder) {
      roots.push(folder.uri);
    } else {
      // No workspace open: fall back to the file's own directory, and one level up so
      // "../images/x.png" style links from a single opened file still have a chance.
      const dir = vscode.Uri.file(path.dirname(docUri.fsPath));
      roots.push(dir, vscode.Uri.file(path.dirname(dir.fsPath)));
    }
    return roots;
  }

  /** Finds Markdown image references and maps each resolvable local path to a URI the
   *  webview is allowed to load. */
  private async resolveImageUris(
    docUri: vscode.Uri,
    text: string,
    webview: vscode.Webview
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img[^>]+src=["']([^"']+)["']/g;
    const dir = path.dirname(docUri.fsPath);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const raw = m[1] || m[2];
      if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue; // skip URLs/data URIs
      const clean = raw.split('#')[0].split('?')[0];
      if (!IMG_EXT.has(path.extname(clean).toLowerCase())) continue;
      if (out[raw]) continue;
      try {
        const abs = path.resolve(dir, decodeURIComponent(clean));
        await vscode.workspace.fs.stat(vscode.Uri.file(abs));
        out[raw] = webview.asWebviewUri(vscode.Uri.file(abs)).toString();
      } catch {
        // Missing file: leave unmapped, the webview shows a "missing image" placeholder.
      }
    }
    return out;
  }

  private async toggleTask(
    document: vscode.TextDocument,
    renderedChecked: boolean[],
    index: number,
    checked: boolean
  ): Promise<void> {
    const text = document.getText();
    const { offsets, reason } = checkTasksEditable(text, renderedChecked);
    if (reason || offsets[index] === undefined) {
      vscode.window.showWarningMessage(`MD Reader: couldn't save that change (${reason || 'task not found'}).`);
      return;
    }
    const offset = offsets[index];
    const pos = document.positionAt(offset);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(pos, pos.translate(0, 1)), checked ? 'x' : ' ');
    // applyEdit goes through VS Code's own document model, so it participates in the
    // normal undo stack (Ctrl+Z) and stays consistent even if the file changed elsewhere.
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) vscode.window.showWarningMessage('MD Reader: could not save that change.');
  }

  private async openLink(fromUri: vscode.Uri, href: string, column: vscode.ViewColumn | undefined): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [rawPath, anchor] = href.split('#');
    if (!rawPath) return; // pure in-page anchor; handled client-side
    const dir = path.dirname(fromUri.fsPath);
    const candidates = [decodeURIComponent(rawPath)];
    const abs = path.resolve(dir, candidates[0]);
    let target: string | undefined;
    for (const c of [abs, abs + '.md', path.join(abs, 'README.md'), path.join(abs, 'index.md')]) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(c));
        target = c;
        break;
      } catch {
        /* try next */
      }
    }
    if (!target) {
      vscode.window.showWarningMessage(`MD Reader: couldn't find "${rawPath}".`);
      return;
    }
    const uri = vscode.Uri.file(target);
    if (/\.(md|markdown|mdown|mkd)$/i.test(target)) {
      await vscode.commands.executeCommand('vscode.openWith', uri, MdReaderEditorProvider.viewType, { viewColumn: column });
      if (anchor) {
        // Give the new panel a moment to render, then ask it to scroll.
        setTimeout(() => {
          for (const p of this.previews) {
            if (p.document.uri.toString() === uri.toString()) p.panel.webview.postMessage({ type: 'scrollTo', anchor });
          }
        }, 300);
      }
    } else {
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: column });
    }
  }

  private async saveExportedHtml(sourceUri: vscode.Uri, html: string): Promise<void> {
    const base = path.basename(sourceUri.fsPath).replace(/\.[^.]+$/, '') + '.html';
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), base)),
      filters: { 'HTML file': ['html'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    const open = await vscode.window.showInformationMessage(`Exported to ${path.basename(target.fsPath)}`, 'Open');
    if (open) await vscode.env.openExternal(target);
  }

  // Busts the webview's resource cache for OUR OWN files (main.js, style.css) across
  // extension updates; vendor libs are pinned by version in their filenames already.
  private readonly assetVersion = Date.now();

  private buildHtml(webview: vscode.Webview): string {
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const own = (p: string) => `${media(p)}?v=${this.assetVersion}`;
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // Mermaid's renderer relies on new Function() for some diagram layouts; without
      // this it silently fails inside the strict webview CSP.
      `script-src ${webview.cspSource} 'unsafe-eval' 'nonce-${n}'`,
    ].join('; ');

    const vendor = [
      'vendor/marked.min.js',
      'vendor/purify.min.js',
      'vendor/highlight.min.js',
      'vendor/katex/katex.min.js',
      'vendor/mermaid.min.js',
    ]
      .map((p) => `<script nonce="${n}" src="${media(...p.split('/'))}"></script>`)
      .join('\n');

    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('vendor', 'katex', 'katex.min.css')}">
<link rel="stylesheet" id="hljs-light" href="${media('vendor', 'hljs-light.css')}">
<link rel="stylesheet" id="hljs-dark" href="${media('vendor', 'hljs-dark.css')}" disabled>
<link rel="stylesheet" href="${own('style.css')}">
<title>MD Reader</title>
</head>
<body>
<div id="toolbar">
  <button id="btn-outline" title="Show / hide the outline (O)">Outline</button>
  <button id="btn-wide" title="Toggle full-width reading">&#8596;</button>
  <button id="btn-export" title="Export as standalone HTML">Export HTML</button>
</div>
<div id="layout">
  <nav id="outline" aria-label="Outline"></nav>
  <div id="page"><article id="doc" class="markdown-body"></article></div>
</div>
<div id="lightbox"><img alt=""></div>
<div id="toast"></div>
${vendor}
<script nonce="${n}" src="${own('main.js')}"></script>
</body>
</html>`;
  }
}
