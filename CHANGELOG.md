# Changelog

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
