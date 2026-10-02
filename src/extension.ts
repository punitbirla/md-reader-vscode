import * as vscode from 'vscode';
import { MdReaderEditorProvider } from './mdReaderEditor';
import { OutlineProvider } from './outline';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MdReaderEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MdReaderEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    })
  );

  // "On This Page": VS Code's built-in Outline panel can't read a custom webview
  // editor's content, so this is a small from-scratch replacement in the same sidebar,
  // kept in sync with whichever MD Reader tab is currently active.
  const outlineProvider = new OutlineProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mdReaderOutline', outlineProvider),
    MdReaderEditorProvider.onActiveChanged((doc) => {
      outlineProvider.refresh(doc);
      vscode.commands.executeCommand('setContext', 'mdReaderPreviewActive', !!doc);
    }),
    vscode.commands.registerCommand('mdReader.jumpToHeading', (index: number) => {
      MdReaderEditorProvider.getActivePanel()?.webview.postMessage({ type: 'scrollToIndex', index });
    })
  );

  const openPreview = (column?: vscode.ViewColumn) => {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri ?? MdReaderEditorProvider.getActiveDocument()?.uri;
    if (!uri) {
      vscode.window.showInformationMessage('MD Reader: open a Markdown file first.');
      return;
    }
    vscode.commands.executeCommand('vscode.openWith', uri, MdReaderEditorProvider.viewType, { viewColumn: column });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('mdReader.openPreview', () => openPreview()),
    vscode.commands.registerCommand('mdReader.openPreviewToSide', () => openPreview(vscode.ViewColumn.Beside)),

    vscode.commands.registerCommand('mdReader.openSource', () => {
      const doc = MdReaderEditorProvider.getActiveDocument();
      if (!doc) return;
      vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
    }),

    vscode.commands.registerCommand('mdReader.exportHtml', () => {
      const panel = MdReaderEditorProvider.getActivePanel();
      if (!panel) {
        vscode.window.showInformationMessage('MD Reader: open a file in the MD Reader preview first.');
        return;
      }
      provider.requestExport(panel);
    }),

    vscode.commands.registerCommand('mdReader.makeDefaultEditor', async () => {
      const config = vscode.workspace.getConfiguration();
      const assoc = { ...(config.get<Record<string, string>>('workbench.editorAssociations') || {}) };
      assoc['*.md'] = MdReaderEditorProvider.viewType;
      await config.update('workbench.editorAssociations', assoc, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('MD Reader is now the default editor for .md files.');
    })
  );
}

export function deactivate(): void {}
