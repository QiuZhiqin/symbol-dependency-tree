# C/C++ Symbol Reference Tree

A VS Code extension that displays C/C++ callers and symbol references as a Source Insight-style horizontal graph in the bottom panel. Each query opens an independent tab whose title is the full target symbol name.

## Features

- Call queries read only the extension's persistent call database. They do not invoke VS Code Call Hierarchy, References, or workspace text search.
- An existing database loads automatically when the workspace starts. A new index is built in the background only when no database exists.
- The database uses string tables, numeric enums, exact offset delta encoding, and lossless gzip compression. In a test on the Linux `net` tree, this reduced the v10 database from 19.06 MiB to 8.15 MiB in v11.
- Saving source code rescans only the changed file and writes the changes to a small delta log. A full snapshot is merged only after the log reaches its threshold. Run **Rebuild C/C++ Call Index** to force a full rebuild.
- Adding a workspace folder scans only the new root, and removing one deletes only its records. Changes to a multi-root workspace no longer invalidate the entire existing index.
- A native item in the VS Code status bar continuously shows the index state and build percentage. Hover over it to view file, function, and reference counts plus detailed progress. Click it to rebuild the index.
- Function-pointer members connect callback-table initializers to multi-level indirect calls such as `ctx->event_ops->callback()`. Member types can be resolved across header files.
- Structs, classes, unions, and enums can be index roots. Querying type `A` lists types that contain `A` and functions that use `A` in parameters, return types, or local declarations.
- Nodes load on demand and expand through multiple caller levels from left to right.
- The graph stays at 100% scale and supports drag and mouse-wheel panning.
- Each node shows only the full function name and automatically sizes its box to fit. Parameters, symbol types, directories, filenames, and default line numbers are hidden.
- Clickable line numbers appear when a caller contains multiple reference locations.
- Click a caller function name to jump to the location where it references the parent node. Double-click a node to jump to its definition.
- The database stores exact reference offsets. File-local `static` functions are scoped to their defining files.
- In addition to direct calls such as `target()`, the index recognizes `INIT_WORK(..., target)`, `register_callback(target)`, `&target`, and function-pointer assignments.
- Enum values, object-like macros, and other identifiers inside function bodies are stored as exact references and can generate caller relationships for their containing functions.
- Local variables are scoped by declaration, block, function, and file. Same-named members are distinguished by the receiver of `.`, `->`, or `::`, or by the owning type of a member function.
- Querying another symbol opens a new tab with that symbol's name. Existing graphs, expansion states, and pan positions remain unchanged.

## Usage

1. Open a C/C++ workspace in VS Code.
2. The extension loads an existing index in the background. On first use, or when no database exists, it builds one automatically.
3. Place the cursor on a target function or symbol and select **Generate Symbol Reference Tree** from the editor context menu.
4. Monitor indexing in the VS Code status bar. Hover for details, click the status item to rebuild, and use `+` in a symbol tab to expand callers one level at a time.

## Commands

| Command | Purpose |
| --- | --- |
| `symbolDependencyTree.show` | Generate a reference tree from the active editor and cursor position |
| `symbolDependencyTree.refresh` | Clear the query cache and rerun the query from its original location |
| `symbolDependencyTree.clear` | Close the current graph tab |
| `symbolDependencyTree.collapseAll` | Collapse all nodes |
| `symbolDependencyTree.rebuildIndex` | Force a rebuild of the persistent C/C++ call database |

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `symbolDependencyTree.persistentIndex.fileExtensions` | Common C/C++ extensions | File extensions included in the call database |

By default, the database is stored in the first VS Code workspace folder:

```text
.symbol-dependency-tree/call-index-<workspace-hash>.json.gz
.symbol-dependency-tree/call-index-<workspace-hash>.delta.json.gz
```

When multiple folders are open, the database remains in the first folder in the workspace list, and the filename hash is tied only to that first root. The complete root list is stored inside the database. Adding or removing other roots incrementally merges records by file URI into the same database. The extension falls back to VS Code global extension storage only when no workspace folder is open. On first use after an upgrade, it losslessly reads v10 data, writes a compact v11 snapshot, and removes old formats and obsolete multi-root hash caches from the same directory only after the atomic write succeeds.

Add the following entry to the source repository's `.gitignore`:

```gitignore
.symbol-dependency-tree/
```

The database does not depend on CodeGraph.

## Development and Verification

```bash
npm install
npm run check
npm run test:integration
npm run package
```

Set `TEST_WORKSPACE_PATH` to run integration tests against a real source workspace. For example, in Windows PowerShell:

```powershell
$env:TEST_WORKSPACE_PATH = '<test-workspace-path>'
npm run test:integration
```

## Known Limitations

- The database uses a lightweight C/C++ lexical scanner, not a complete Clang AST.
- Macros and enums are referenced by their exact source identifiers; preprocessor expansion is not performed.
- Conditional compilation, complex macro expansion, identifier concatenation, function pointers passed across functions, template instantiation, and dynamic dispatch may produce missed references.
- Member ownership is inferred from source declarations and receiver expressions. Complex templates, chained temporary objects, and macro-generated declarations may prevent type resolution.
- Same-named global functions in different files and C++ overloads are currently merged by function name. File-local `static` functions remain distinct.
