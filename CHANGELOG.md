# Changelog

All notable changes to the MD Reader VS Code extension are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## [1.1.1] - 2026-10-02

### Fixed
- The "On This Page" outline from 1.1.0 lived only in the Explorer sidebar, where it was easy to miss and had no visible way to hide or show it. The outline is now also shown **inside the preview itself**, on the left, with an **Outline** button in the toolbar (or press `O`) to hide and show it. It lists the document's headings nested by level, highlights the section you're reading as you scroll, and clicking a heading jumps to it. Your choice is remembered across files and sessions, and the pane hides itself automatically in very narrow windows.
- The toolbar (Outline, full-width, Export HTML buttons) scrolled out of view with the page instead of staying pinned at the top.

## [1.1.0] - 2026-10-02

### Added
- **"On This Page"**, a new sidebar view (next to Explorer's Outline and Timeline) listing the open document's headings, nested by level — click one to scroll the preview straight to it. VS Code's own built-in Outline panel can't read a custom webview editor's content, so this is a purpose-built replacement, kept in sync live as you switch files or edit. Hide or show it the same way as any other Explorer view (right-click its header → **Hide 'On This Page'**, or toggle it back from any view's header menu).

### Changed
- **`.md` files now open in MD Reader by default**, with no setup step. (Previously this needed running **MD Reader: Use as Default Editor for Markdown Files** once.) To edit raw text instead, right-click a tab → **Reopen Editor With...** → **Text Editor**, or remove the `*.md` entry from `editor associations` in Settings.

## [1.0.0] - 2026-10-01

First release.

### Added
- A custom editor ("Open With... → MD Reader") that renders Markdown instead of showing raw text: tables, task lists, strikethrough, autolinks, `<details>` blocks and YAML front matter.
- Syntax-highlighted code blocks with a copy button.
- Mermaid diagrams and KaTeX math (inline `$..$`, block `$$..$$`, and ` ```math ` blocks).
- Callouts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`.
- Tickable checkboxes, in task lists and in table cells, that save straight into the document via a `WorkspaceEdit` — so `Ctrl+Z` undoes a tick like any other edit, and the file is only written when you save, same as editing text.
- Automatic light/dark/high-contrast theming that follows the active VS Code theme, with no settings needed.
- Relative links open the target file in MD Reader (or the default viewer for non-Markdown files); local images resolve from disk.
- Commands: **Open Preview**, **Open Preview to the Side** (`Ctrl+Shift+M`), **View Source**, **Export as Standalone HTML**, **Use as Default Editor for Markdown Files**.
- Everything needed ships inside the extension package — no setup step, no internet access required after installing.
