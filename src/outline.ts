// Powers the "On This Page" sidebar view: VS Code's own built-in Outline panel only
// works with standard text editors, not a custom webview-based one like ours, so this
// is a small from-scratch replacement — a heading tree, built from the same `marked`
// parse the webview itself renders, kept in sync with whichever MD Reader tab is active.
import * as vscode from 'vscode';
import { marked } from 'marked';
import { splitFrontMatterBody } from './taskEdit';

export interface HeadingNode {
  title: string;
  depth: number;
  /** Position among ALL headings in document order — matches the webview's own
   *  `querySelectorAll('h1,h2,h3,h4,h5,h6')` indexing, so a click can tell it which one. */
  index: number;
  children: HeadingNode[];
  /** True only for the "no headings" placeholder row — not a real, clickable heading. */
  placeholder?: boolean;
}

/** Turns "**bold** and `code`" into "bold and code" — marked's lexer gives heading text
 *  with its inline markdown syntax still in place; the tree label wants it stripped. */
function plainText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseHeadings(text: string): HeadingNode[] {
  const tokens = marked.lexer(splitFrontMatterBody(text));
  const flat: { title: string; depth: number }[] = [];
  const walk = (list: any[]) => {
    for (const t of list) {
      if (t.type === 'heading') flat.push({ title: plainText(t.text), depth: t.depth });
      else if (t.tokens && t.type !== 'heading') walk(t.tokens);
    }
  };
  walk(tokens as any[]);

  // Build a tree from the flat, depth-tagged list (same shape as the web app's indented
  // "On this page" list): each heading nests under the nearest preceding shallower one.
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  flat.forEach((h, index) => {
    const node: HeadingNode = { title: h.title || '(untitled)', depth: h.depth, index, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : root).push(node);
    stack.push(node);
  });
  return root;
}

export class OutlineProvider implements vscode.TreeDataProvider<HeadingNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: HeadingNode[] = [];

  /** Called whenever the active MD Reader document changes or is edited.
   *  `undefined` means no MD Reader preview is currently active. */
  refresh(document: vscode.TextDocument | undefined): void {
    this.roots = document ? parseHeadings(document.getText()) : [];
    this.emitter.fire();
  }

  getTreeItem(element: HeadingNode): vscode.TreeItem {
    if (element.placeholder) {
      const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
      item.description = '';
      return item;
    }
    const item = new vscode.TreeItem(
      element.title,
      element.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.command = { command: 'mdReader.jumpToHeading', title: 'Go to Heading', arguments: [element.index] };
    item.tooltip = `${'#'.repeat(element.depth)} ${element.title}`;
    return item;
  }

  getChildren(element?: HeadingNode): HeadingNode[] {
    if (!element) {
      if (!this.roots.length) {
        return [{ title: 'No headings in this document', depth: 0, index: -1, children: [], placeholder: true }];
      }
      return this.roots;
    }
    return element.children;
  }
}
