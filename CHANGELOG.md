# Changelog

## 0.11.2

- Speed up caller queries for names that many types share, such as generated `class_swap` members: the virtual-dispatch lookups are built once after the types change instead of for every compared candidate.
- Find member callers through `std::shared_ptr`, `std::unique_ptr` and `std::weak_ptr` receivers, including `auto p = m_task.lock()`, `std::make_shared<T>()` and `auto` results whose chain starts at a class member or a typed local. `p.reset()` and the smart pointer's other own members are not taken as calls to the pointee.
- Keep calls in control conditions and unbraced bodies from being mistaken for local declarations, while preserving real condition variables and init-statements. Rebuild existing indexes once to replace the old scope metadata.
- Keep a root node on its definition while the file is edited: clicking the root name follows lines inserted or deleted above the symbol instead of opening the line it had when the tree was generated.
- Halve the index database. References to local variables and parameters are no longer stored; they are found by scanning the current file when queried, so they also follow unsaved edits. A per-file list of referenced names replaces the index on file numbers. Existing indexes are rebuilt once after the update, and the old database file shrinks instead of keeping its size. The reference count in the status bar no longer includes local references.
- Speed up queries for names that many local variables share, such as `i`, `len`, or `data`, and index updates of large files.
- Check and read local files directly instead of through VS Code's file service, so reopening a large workspace no longer waits several seconds before queries run, and a full rebuild takes about a third less time.
- Truncate the database's write-ahead log after each update, so a rebuild no longer leaves a log as large as the index on disk until the window closes.
- Log how long listing, reading and scanning, writing, committing, and publishing took whenever the index becomes ready.
- Scan files on up to two worker threads during rebuilds, startup checks, and workspace-folder updates while the extension host writes the index in file order. A full rebuild of a 21,000-file workspace takes about half as long, with shorter pauses of the extension host. Idle workers stop after 30 seconds.

## 0.11.0

- Store the symbol index in a SQLite database (the built-in `node:sqlite` of VS Code 1.101 or newer) in VS Code's workspace storage instead of a gzip snapshot under the first workspace folder. Queries read only the rows they need, so large workspaces no longer keep the whole index in memory or reload it at startup. Index files from earlier versions are removed after the first successful build.
- Index references inside file-scope `#define` replacement text, so a function called only through a macro such as `RTMPInitTimer` shows the macro as its caller, and the macro's own callers below it. Macro parameters are not indexed as references, and macros that reference nothing are left out.
- Skip files larger than `symbolDependencyTree.persistentIndex.maxFileSizeMB` (4 MB by default), such as generated register headers and data tables.
- Speed up indexing by masking comments, literals, and preprocessor lines without per-character arrays, and by skipping the qualified-name scan for identifiers that are not preceded by `::`; large data tables no longer make function detection quadratic.
- Recognize a designated-initializer callback without a trailing comma, such as `.pfHandler = UniCmdBssInfoBcnOffloadWrapAll }`, so the callback table shows up as its caller.
- Read and mask each referenced file once per expansion when building reference previews, re-reading only when the document changes, and refresh trees in background tabs when they are shown.
- Apply nearby file updates as one batch, and skip the refresh notification when a reopened index has nothing to update.

## 0.10.0

- Jump to the symbol definition when clicking a root node name, whether the tree was generated at the definition site or at any call site.
- Resolve cross-file member-function and macro definitions for root navigation, including `obj.member` receivers and facades such as `g_vbss_ops.vbss_if_get_sta_assoc`.
- Disambiguate same-name definitions by call arity, so indexing `vbss_if_get_sta_entry` binds the 4-argument facade instead of the 3-argument platform implementation.
- Treat a bare call inside a member function as a free function when the enclosing class (or its ancestors) never declares that member, keeping namespaces and qualified calls intact.
- Focus the existing graph tab when re-indexing a symbol that is already open, instead of duplicating the window; the tab identity is the index-bound definition.
- Add real-source end-to-end regression tests against the prplMesh/libvbss fixtures and a `getRootJumpTarget` automation API.

## 0.9.9

- Add the **Close All Symbol Trees** command and panel action to dismiss every open graph tab at once.
- Keep only **Refresh** and **Close All Symbol Trees** in the panel toolbar; the remaining commands stay available from the command palette.

## 0.9.8

- Keep namespace-owned definitions aligned with qualified calls and index template-id calls such as `invoke<long>()` as callable references.
- Recognize `const`, `volatile`, `noexcept`, ref-qualified, and trailing-return C++ function definitions.
- Keep constructors and destructors distinct and recognize qualified member-function addresses such as `&Worker::run`.
- Recover virtual base-type dispatch through `auto` receivers, preferring the target inheritance family when a receiver variable such as `task` collides with an unrelated lowercase `task` type, while rejecting unsafe same-name virtual hierarchies.
- Keep address-of function arguments such as `memcpy(&global_value, ...)` bound to the global symbol instead of misclassifying them as local function-pointer declarations.
- Add advanced C++ unit and integration fixtures, with explicit follow-up cases for overloads, operators, callable wrappers, member pointers, smart pointers, and constructor initializer lists.
- Add an end-to-end `VbssTask::handle_cmdu` regression fixture modeled on the real prplMesh `TaskPool` dispatch path.
- Rebuild version 17 of the persistent database automatically after upgrade.

## 0.9.7

- Rewrite the extension overview as a user-focused guide covering supported symbols, graph interaction, automatic index updates, and troubleshooting.
- Use consistent user-facing labels for the bottom panel, editor commands, index rebuild action, and extension setting.

## 0.9.6

- Debounce and index the current in-memory document after every C/C++ editor change, including unsaved edits.
- Refresh every open graph tab only after the matching index update completes, keeping call-site ranges and navigation synchronized with the source.
- Reindex saved files immediately and restore the on-disk index when an edited document closes, without relying solely on filesystem watcher delivery.

## 0.9.5

- Index C++ base-class relationships and `virtual`/`override` declarations for reverse virtual-dispatch lookup.
- Link base-typed calls such as `task->handle_ieee1905_1_msg()` to matching derived overrides without merging unrelated or non-virtual methods.
- Resolve calls through unqualified typed data members and rebuild version 15 of the persistent database automatically after upgrade.

## 0.9.4

- Select the complete source line when opening a graph call site instead of highlighting only the referenced symbol name.
- Extend selections across multiline calls through the matching closing parenthesis and semicolon.
- Keep definition navigation precise when opening a node definition directly.

## 0.9.3

- Resolve function-pointer members reached through initialized, uninitialized, pointer, and `extern` global objects back to their declared structure type.
- Keep wrapper functions such as `vbss_if_get_sta_entry` in the reverse-reference tree and allow their direct callers to be expanded normally.
- Persist global object type information for cross-file resolution and rebuild version 14 of the database automatically after upgrade.

## 0.9.1

- Recognize positional function-pointer entries such as `{ "rept_table", Show_ReptTable_Proc }` as callable references.
- Rebuild version 12 of the persistent database so previously misclassified callback-table entries are corrected automatically after upgrade.
- Exclude workspace call-index snapshots from packaged VSIX files.

## 0.9.0

- Store version 11 snapshots with lossless string interning, numeric enums, tuple records, and exact delta-coded source offsets.
- Persist ordinary file changes in a compact delta journal and atomically compact it into the base snapshot only after size or entry thresholds are reached.
- Keep the database identity stable on the first workspace root and incrementally scan added roots or remove records from detached roots.
- Migrate compatible version 10 indexes without rescanning unchanged files; Linux `net` measured 19.06 MiB before migration and 8.15 MiB afterward.
- Remove obsolete workspace-combination and legacy-format caches only after the stable version 11 snapshot has been atomically written.
- Add a small left inset to graph tabs so full function names remain readable without wasting panel space.
- Use more compact function nodes, call-site links, and vertical branch spacing so larger graphs fit in the panel.

## 0.8.7

- Keep the default arrow cursor over the graph canvas while using the pointer cursor for clickable function names, line links, tabs, and expand/collapse controls.
- Keep equality and inequality comparisons from being misidentified as local declarations.
- Rebuild version 10 of the persistent database so corrected macro references are indexed automatically.

## 0.8.6

- Reduce graph expand/collapse controls from 16 px to 12 px.
- Place expand/collapse controls outside the right edge of each node and vertically center them.
- Remove the node's internal padding that was reserved for the controls.

## 0.8.5

- Remove the graph's initial 30 px horizontal pan offset.
- Remove the extra 45 px left and right graph-layout padding so content can reach the panel edges.

## 0.8.4

- Reduce the graph node expand/collapse controls from 21 px to 16 px.
- Wrap graph tabs onto additional rows when the title bar is full.
- Keep the graph viewport and empty-state message below the dynamically sized tab bar.

## 0.8.3

- Store the persistent call index as gzip-compressed JSON instead of plain JSON.
- Reduce the measured 415,936,757-byte production index to about 33 MB without dropping any indexed symbols or scope data.
- Read compatible legacy `.json` indexes, migrate them to `.json.gz`, and remove the old cache only after the compressed file is written successfully.

## 0.8.2

- Make `struct`, `class`, `union`, and `enum` definitions queryable index roots.
- Link a type to containing member declarations and to function signatures or local declarations that use it.
- Show containing types and functions as separate graph nodes without duplicating member declarations or nested method bodies.
- Rebuild version 9 of the persistent database automatically.

## 0.8.1

- Index designated callback-table initializers such as `.callback = implementation` outside function bodies.
- Resolve chained indirect calls such as `ctx->event_ops->callback()` through member types declared in other files.
- Show global callback-table variables as caller nodes and rebuild version 8 of the persistent database automatically.

## 0.8.0

- Show the persistent index state in a native VS Code status bar item instead of above the graph.
- Show disk loading and build percentage in the status bar; expose file, function, reference, progress, cancellation, and error details in its hover popup.
- Start loading the persisted index after workspace activation and rebuild it when the status bar item is clicked.

## 0.7.1

- Recognize packing/export/attribute macros placed between `struct`, `class`, or `union` and the actual type tag.
- Resolve declarations such as `struct GNU_PACKED add_vbss_entry_msg` to `add_vbss_entry_msg::stamac`, matching references through `msg->stamac`.
- Rebuild version 7 of the persistent database so previously misidentified attributed types are re-indexed.

## 0.7.0

- Bind local-variable references to their declaration, containing block, function, and file instead of merging equal names workspace-wide.
- Bind member references reached through `.`, `->`, `::`, or an implicit member-function receiver to the owning type.
- Keep equal member names on different types separate in the persistent reverse-reference index.
- Rebuild version 6 of the persistent database automatically so existing workspaces receive the scope-aware schema.

## 0.6.0

- Store the active index under `.symbol-dependency-tree/` in the first VS Code workspace folder.
- Keep the complete multi-root workspace identity in the hashed database filename so different folder combinations do not overwrite each other.
- Fall back to VS Code global extension storage only when no workspace folder is open.
- Copy a compatible legacy global index into the workspace on first use without deleting the old database.

## 0.5.0

- Move the horizontal graph back to a dedicated bottom Panel view.
- Keep every query as an independent, closeable tab inside the bottom view, titled with the complete queried symbol name.
- Store exact enum-value, object-like macro, and other identifier references found inside C/C++ function bodies.
- Keep function caller queries restricted to direct calls, callback registrations, address-taken functions, and function-pointer assignments.
- Fix indexing of the first function in a source file when preprocessor directives appear before it.
- Validate Linux 5.10.220 `WLAN_ACTION_ADDBA_REQ` at `ieee80211_send_addba_request:95`, `ieee80211_iface_work:1366`, and `ieee80211_rx_h_action:3394`.

## 0.4.0

- Index bare function callbacks passed to APIs and macros, address-taken functions, and function-pointer assignments in addition to direct calls.
- Resolve Linux 5.10.220 `ieee80211_iface_work` to `ieee80211_add_virtual_monitor` at line 975 and `ieee80211_setup_sdata` at line 1532.
- Open every search in a new Webview editor tab titled with the queried function name, preserving all earlier graphs for tab switching.
- Keep the Linux `net` full rebuild near four seconds after optimizing callback-argument recognition.

## 0.3.2

- Size every graph node from its rendered function name and optional call-site buttons instead of reserving a fixed 360-pixel width.
- Use actual per-node widths for column placement, world bounds, and connection endpoints.
- Reduce vertical padding and verify variable Webview pixel widths in the Linux `net` Extension Host integration test.

## 0.3.1

- Make the plugin-managed call-index database the only caller-query source.
- Remove Call Hierarchy, References, full-workspace text fallback, its command, and its settings from the query path.
- Normalize right-click targets to plain function names before database lookup.
- Add an Extension Host integration assertion against Linux 5.10.220 `net`: `__sta_info_destroy_part1` resolves to `__sta_info_destroy` at line 1117 and `__sta_info_flush` at line 1217.

## 0.3.0

- Add a plugin-managed persistent C/C++ caller-index database in VS Code global storage.
- Parse and store exact caller names and call-site offsets on the first query, then query an in-memory reverse-call map.
- Incrementally re-index only changed files and provide a **Rebuild C/C++ Call Index** command.
- Query in this order: Call Hierarchy, References, persistent index, then full-workspace text fallback.
- Validate Linux 5.10.220 `net`: 1,666 files, 32,096 functions, and 206,276 call sites indexed in about 1.8 seconds on the test machine.

## 0.2.5

- Add an internal C/C++ lexical function-scope scanner when Document Symbols are unavailable.
- Keep text-fallback caller nodes expandable instead of collapsing all matches into a file node.
- Validate the fallback against Linux 5.10.220 `__sta_info_destroy_part1`, including its direct and macro-nested callers.

## 0.2.4

- Make a caller's function name open the first location where it calls its parent function.
- Keep explicit line buttons for callers with multiple call sites and preserve definition navigation on node double-click.

## 0.2.3

- Make graph-node payloads contain only the plain function name, with no parameters, symbol-kind label, folder, filename, or default source line.
- Keep source line buttons only when a caller has multiple distinct call sites.

## 0.2.2

- Keep the horizontal graph at a fixed 100% scale with no automatic fit or zoom.
- Simplify every graph node to its complete function name.
- Show inline clickable line numbers when one caller contains multiple call sites.

## 0.2.1

- Re-prepare Call Hierarchy items at every level so caller chains continue beyond the first parent.
- Remove function declarations and definitions from reference-location branches.
- Display the most complete qualified function name or signature without ellipsis.
- Dynamically reserve vertical space for wrapped long function names.

## 0.2.0

- Replace the native vertical TreeView with a Source Insight-style left-to-right graph.
- Add curved dependency edges, lazy horizontal expansion, panning, zooming, and fit-to-view.
- Add a reference-details pane and definition navigation from graph nodes.

## 0.1.0

- Add the native Symbol References panel and lazy reverse-reference tree.
- Add Call Hierarchy, References, scope grouping, recursion detection, and navigation.
- Add cancellable approximate C/C++ text fallback with comment and literal filtering.
- Add refresh, clear, collapse, retry commands, settings, fixtures, and unit tests.
