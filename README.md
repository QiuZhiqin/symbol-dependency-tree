# C/C++ Symbol Reference Tree

Explore C/C++ symbol references in a Source Insight-style graph at the bottom of VS Code. Place the cursor on a function, variable, type, or macro to see where it is used, then expand any node with `+` to follow the caller chain one level at a time.

## Highlights

- **Explore callers step by step** — Start from any supported symbol and expand its callers from left to right.
- **Query more than functions** — Functions, methods, variables, structs, classes, unions, enums, macros, and callbacks can all participate in the index.
- **Follow indirect calls** — Function pointers, callback tables, member callbacks, and common virtual-dispatch patterns are recognized.
- **Jump directly to source** — Click a caller to open the reference, double-click a node to open its definition, or select a line number when multiple references exist.
- **Stay synchronized while editing** — The changed file is reindexed automatically when you edit, save, or close it. A full workspace rebuild is not required for normal changes.
- **Keep multiple investigations open** — Each query opens in its own tab so you can switch between call trees without losing context. Re-indexing a symbol that is already open focuses its existing tab instead of duplicating it.
- **Match your VS Code theme** — Graph colors, text, borders, and backgrounds follow the active VS Code theme.

## Getting Started

1. Open a C or C++ workspace in VS Code.
2. Wait for the index status in the status bar to report that it is ready. The first scan can take some time in a large workspace.
3. Place the cursor on the function, variable, type, or macro you want to inspect.
4. Right-click in the editor and choose **Generate Symbol Reference Tree**.
5. In the bottom panel, click `+` beside a node to continue expanding its callers.

## Working with the Graph

| Action | Result |
| --- | --- |
| Click a node name | Root node: open the symbol definition; other nodes: open the call to the parent |
| Double-click a node | Open the symbol definition |
| Click `+` | Load callers or references for that node |
| Click `−` | Collapse the current branch |
| Click a line number | Open a specific location when one caller contains multiple references |
| Drag the canvas | Pan across a large graph |
| Use the mouse wheel | Move through the graph area |

## Automatic Index Updates

The extension keeps the workspace index up to date automatically:

- While you edit, only the current file is refreshed after a short delay.
- Saving a file refreshes that file immediately.
- Creating, deleting, or renaming source files updates the corresponding records.
- Adding or removing a workspace folder processes only the affected folder.

You normally do not need to rebuild the entire index. Use **Rebuild C/C++ Symbol Index** if the status bar reports a persistent error, the workspace was changed extensively by an external tool while VS Code was closed, or results appear incomplete. You can also click the index item in the status bar to start a rebuild.

## Commonly Supported Patterns

- Direct calls such as `target()`
- Callback registration such as `register_callback(target)`
- Function addresses such as `&target`
- Callback tables and function-pointer assignments
- Struct or class member callbacks such as `ctx->ops->callback()`
- Virtual calls through a base-class pointer and matching derived overrides
- Member calls through `std::shared_ptr`, `std::unique_ptr`, and `std::weak_ptr`, including `auto p = m_task.lock(); p->run();` and `std::make_shared<T>()`
- Same-name definitions in different files matched by their call-site argument counts, for example a multi-argument facade next to a platform-specific implementation
- Structs, classes, unions, and enums used in parameters, return values, members, and local declarations
- Variables, enum values, object-like macros, and other identifiers referenced inside function bodies

## Commands

| Command | Purpose |
| --- | --- |
| **Generate Symbol Reference Tree** | Open a reference tree for the symbol at the cursor, focusing the existing tab if that symbol is already open |
| **Refresh Symbol Reference Tree** | Run the query for the current tab again |
| **Close All Symbol Trees** | Close every open graph tab at once |
| **Close Current Symbol Tree** | Close the active graph tab |
| **Collapse All Nodes** | Collapse every branch in the current graph |
| **Rebuild C/C++ Symbol Index** | Rescan the entire workspace |

## Settings

Use `symbolDependencyTree.persistentIndex.fileExtensions` to choose which source-file extensions are indexed. Common C and C++ extensions such as `.c`, `.cpp`, `.h`, and `.hpp` are included by default.

Use `symbolDependencyTree.persistentIndex.maxFileSizeMB` to skip very large files such as generated register headers and data tables. Files larger than 4 MB are skipped by default; set it to `0` to index every file.

## Index Storage

The index is a SQLite database (`call-index-<hash>.sqlite`) in VS Code's storage for the current workspace, outside the source tree, so it needs no `.gitignore` entry. It uses the `node:sqlite` module built into VS Code 1.101 or newer.

- Calls are read from the database for each query, so a large workspace does not keep the whole index in memory. References to local variables and parameters are not stored; they are found by scanning the current file when queried, so they also follow unsaved edits.
- When the workspace is reopened, the saved index is reused and only files whose size or modification time changed are rescanned.
- A rebuild is written in a single transaction. Cancelling it keeps the previous index.
- Each time the index becomes ready, the **Symbol Dependency Tree** output channel logs how long listing, reading and scanning, and writing took.
- After an extension update that changes the index format, or if the database file is damaged, the old index is discarded and the workspace is rescanned once automatically.
- Earlier versions kept a `.symbol-dependency-tree` directory under the first workspace folder; the extension removes those old index files after it has built the new database.

The index stays on your machine. The extension does not depend on CodeGraph and does not upload source code.

## If a Query Returns No Results

1. Check the status bar and make sure indexing is ready.
2. Confirm that the target file extension is included in the extension settings.
3. Save the current file and run the query again.
4. If an external tool changed many files, run **Rebuild C/C++ Symbol Index** once.

## Known Limitations

- Complex macro expansion, token concatenation, and conditional compilation can hide some references.
- Function pointers passed through several functions, advanced template instantiation, and macro-generated declarations may not be fully resolved.
- Same-named global functions and C++ overloads with identical parameter counts can be merged in some cases; definitions with different argument counts are matched by arity. File-local `static` functions remain separate.
- Smart-pointer type aliases such as `using TaskPtr = std::shared_ptr<T>`, copies such as `auto p = m_task;`, and call results used directly as receivers such as `m_task.lock()->run()` are not followed. Calls to pointee members that share a name with smart-pointer members, such as `p->reset()`, are not counted as calls to the pointee.
- A member declaration whose nested template ends in `>>`, such as `std::vector<std::shared_ptr<T>> m_tasks;`, is not recorded; writing `> >` works.
- If a file changes outside VS Code while it is closed, a root node for a struct, variable, macro, or same-file overload can still open its old line; generate the tree again from the definition.
- The extension uses lightweight C/C++ source analysis rather than a complete Clang compilation model.
