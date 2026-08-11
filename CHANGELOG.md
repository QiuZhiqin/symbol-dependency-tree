# Changelog

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
