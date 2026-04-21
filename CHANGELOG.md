# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.1] - 2026-04-21

### Fixed
- **Test directory creation**: Fixed Windows test failures by ensuring parent directories exist before writing global config files
- **Source code modularization**: Refactored monolithic `src/index.ts` into focused modules: `src/server-state.ts`, `src/tools.ts`, `src/viewer-html.ts`, `src/viewer-server.ts`

## [2.6.0] - 2026-04-21

### Added
- **Config governance CLI**: Added `ssh-session-mcp-config` / `npm run config -- ...` for merged config inspection, device edits, default-device updates, and runtime default management
- **Repository validator**: Added `ssh-session-mcp-validate-repo` / `npm run validate:repo` to check required docs, example config validity, acceptance scenario ids, `.env.example` tokens, and MCP tool coverage in docs
- **Cross-tool response contract documentation**: Added `docs/contracts.md` for standardized tool response fields
- **Normalized failure taxonomy documentation**: Added `docs/failure-taxonomy.md` for consistent error categorization
- **Acceptance scenario baseline**: Added `docs/acceptance-scenarios.md` for defining expected user workflows
- **Platform/runtime compatibility notes**: Added `docs/platform-compatibility.md` for deployment guidance
- **Example multi-device config**: Added `docs/examples/ssh-session-mcp.config.example.json` for configuration reference
- **Unit coverage**: Added tests for config merging, contract helpers, and repository validation helpers

### Changed
- **Tool response standardization**: Tool responses now expose normalized `resultStatus` / `summary` / `nextAction` style contract fields while keeping existing payload fields compatible
- **Config loading model**: Config loading now explicitly models workspace config, user-global config, explicit config paths, loaded file lists, and resolution mode
- **Documentation updates**: README, `README.zh-CN.md`, and `AI_AGENT_GUIDE.md` now document config resolution order, repo validation, response contracts, and repo scope boundaries
- **Git ignore patterns**: `.gitignore` now keeps repo docs versionable while still ignoring local draft/private docs

## [2.5.0] - 2026-04-21

### Added
- **Multi-device / multi-connection management**: One MCP instance can manage multiple device profiles, each with configurable defaults and authentication
- **Per-AI instance isolation**: Run separate stdio MCP processes with different `SSH_MCP_INSTANCE` values to prevent interference between AI agents
- **Device configuration files**: JSON config files (`ssh-session-mcp.config.json`) replace environment variables for multi-device setups
- **New CLI command**: `npm run devices` / `node scripts/ctl.mjs devices` lists configured device profiles and defaults
- **New MCP tools**: 
  - `ssh-device-list`: List configured device profiles and defaults
  - `ssh-session-set-active`: Set or clear the active session used when `session` parameter is omitted
- **Automatic viewer port allocation**: `VIEWER_PORT=auto` selects a random free port when `0` (disabled) or fixed port is not desired

### Changed
- **Environment variable defaults**: `AUTO_OPEN_TERMINAL` now defaults to `false`, `VIEWER_PORT` defaults to `0` (disabled)
- **Legacy single-device mode**: Environment variables (`SSH_HOST`, `SSH_USER`, etc.) remain supported but are now labeled "legacy" in `.env.example`
- **Runtime directory structure**: Logs and state files now use per-instance directories under system-appropriate locations (XDG/AppData)
- **CLI launch behavior**: `scripts/ctl.mjs launch` now accepts `--instance`, `--device`, and `--connection` flags for precise control

### Technical
- New modules: `src/profiles.ts` (device profile loading), `src/runtime.ts` (instance-aware path resolution)
- Enhanced configuration resolution with fallback: config file → legacy env vars → defaults
- Updated unit tests for profiles and runtime helpers
- JSON schema validation for device config files using Zod

## [2.4.0] - 2026-04-21

### Added
- **Session diagnostics**: Added `ssh-session-diagnostics` to inspect terminal mode, input lock state, viewer attachment state, running command metadata, logging state, and trim warnings
- **Line-numbered history**: Added `ssh-session-history` so agents can recall mixed SSH output, user input, AI input, and lifecycle events as numbered lines
- **Local JSONL metadata logs**: Added optional `SSH_MCP_LOG_MODE=meta` and `SSH_MCP_LOG_DIR` for file-only local logging of session, viewer, lock, and command metadata
- **CLI log viewer**: Added `npm run logs` / `node scripts/ctl.mjs logs` to inspect local server or session logs without polluting MCP stdio

### Changed
- **Unified read-more hints**: `ssh-run`, `ssh-command-status`, and `ssh-session-read` now expose consistent offset guidance for continuing truncated or live output reads
- **Lighter launch behavior**: `scripts/ctl.mjs launch` now reuses a healthy existing viewer/server when possible instead of always killing the current process first
- **Viewer / lock observability**: Session lock changes, browser mode changes, viewer launches, viewer reuse, and async command lifecycle transitions are now captured as local metadata events

### Technical
- New modules: `src/history.ts`, `src/paging.ts`, `src/logger.ts`, `src/diagnostics.ts`
- `SSHSession` now maintains an in-memory line history ring buffer alongside raw output and transcript events
- Added focused unit tests for history, paging, diagnostics, and logger helpers
- Logging remains local-only and metadata-only by default; no SSH transcript or full command text is written unless future versions explicitly add a different mode

## [2.3.2] - 2026-04-20

### Fixed
- **CR-only PTY completion detection**: Normalized `\r\n` / `\r` before prompt and sentinel matching so boards that primarily echo carriage returns no longer miss command completion
- **`ssh-retry` lock leaks**: Added guaranteed lock release on retry execution errors so the shared terminal is not left stuck in `agent` mode
- **Async command completion tracking**: Background async monitoring now keeps using sentinel markers, preserves exit codes, cleans sentinel artifacts from returned output, and no longer marks a still-running command as completed when an internal monitor window times out

## [2.3.1] - 2026-04-20

### Fixed
- **Sentinel exit code expansion**: Fixed the injected shell trailer so `${__MCP_EC}` is expanded correctly, restoring reliable exit code capture for `ssh-run` and `ssh-retry`
- **Output loss after command completion**: Fixed sentinel cleanup logic so PTY output using `\r`/mixed line endings no longer has real command output removed together with the sentinel
- **Sentinel exit code parsing**: Fixed exit code extraction to read from the actual emitted sentinel output instead of the echoed command text

## [2.3.0] - 2026-04-20

### Added
- **Bilingual README**: Added `README.zh-CN.md`, and both English/Chinese READMEs now link to each other for easier navigation

### Changed
- **Architecture direction clarified**: Terminal viewer now defaults to the interactive raw-PTY path, while browser mode remains the richer collaborative control surface
- **Terminal viewer defaults**: Auto-launched terminal viewer now starts with `--interactive=true`, `--statusBar=false`, and `--helpFooter=false` for a cleaner SSH-like experience
- **Browser terminal stability**: Improved xterm browser reconnect behavior, line ending handling, scrollback, and auto-scroll behavior
- **Community docs cleanup**: Updated `CODE_OF_CONDUCT.md` enforcement wording to remove placeholder contact text and make the sentence read naturally

### Deprecated
- **Legacy polling browser pages**: `/session/*` and `/binding/*` compatibility pages are now marked as pending removal in favor of the newer terminal/browser entry paths
- **Legacy polling terminal viewer path**: The non-interactive HTTP polling branch in `ssh-session-mcp-view` is now marked as pending removal; the interactive WebSocket attach path is the default

## [2.2.0] - 2026-04-20

### Added
- **Deterministic completion markers**: Commands now use unique sentinel markers (`___MCP_DONE_<id>_<exitcode>___`) for reliable completion detection and exit code capture
- **Browser mode switching**: Safe/Full operation mode can be toggled directly from the browser terminal UI with confirmation dialog for Full mode
- **Structured command parsers**: `ssh-run` automatically parses output of common commands (git status, git log, ls -la) into structured JSON in the `parsed` field
- **New tool `ssh-retry`**: Automatic retry with configurable backoff (fixed/exponential) for flaky commands, with success/fail pattern matching
- **New tool `ssh-command-status`**: Poll status and output of long-running async commands
- **Exit code in response**: `ssh-run` now returns the command's exit code when sentinel markers are enabled

### Changed
- **Default wait time**: Increased to 30 seconds (from 2s) with intelligent early completion via prompt/sentinel/idle detection
- **Sentinel-first detection**: Completion detection now prioritizes sentinel markers over prompt patterns and idle timeout
- **Improved password prompt detection**: Regex now handles `[sudo] password for user:` and similar formats
- **Concurrent command protection**: `ssh-run` returns `AGENT_BUSY` error if another command is already running on the same session
- **Faster cleanup**: Running commands cleaned up after 5 minutes (down from 10), stuck commands auto-interrupted after 10 minutes

### Fixed
- **Race condition in waitForCompletion**: Output listener now registered before initial buffer check to prevent missed output
- **Shell compatibility**: Sentinel uses `__MCP_EC=$?` variable capture on separate line to correctly handle pipes and subshells
- **Password detection false negatives**: Fixed regex to match `[sudo] password for user:` format

### Technical
- New module: `src/parsers.ts` for structured output parsing
- New module: `src/validation.ts` for command validation and terminal mode detection
- `waitForCompletion` now accepts `sentinel` parameter for deterministic detection
- `CompletionResult` type extended with `'sentinel'` reason and `exitCode` field
- `OPERATION_MODE` is now mutable via WebSocket (browser UI control)
 - Added `SSH_MCP_USE_MARKER` env var to disable sentinel markers (default: enabled)

## [2.2.2] - 2026-04-20

### Added
- **Sentinel echo detection**: New `findSentinelOutput` method distinguishes between command echo and actual sentinel output to prevent false matches
- **ANSI-aware matching**: Prompt detection and sentinel matching now strip ANSI escape sequences before pattern matching

### Changed
- **Sentinel stripping logic**: `stripSentinelFromOutput` now filters out lines containing sentinel markers or `__MCP_EC=$?` instead of line-based removal
- **Buffer tail size**: Increased from 2000 to 4000 characters for more reliable sentinel detection in long outputs
- **Output reading**: `SSHSession.read` now returns raw buffer with ANSI sequences preserved for downstream processing

### Fixed
- **False sentinel detection**: Fixed issue where command echo `echo "___MCP_DONE_xxx_$__MCP_EC___"` was incorrectly detected as completion marker
- **Prompt matching with ANSI**: Shell prompt detection now works correctly even when prompts contain ANSI color codes
- **Sentinel line removal**: Both occurrences of sentinel markers (command echo and actual output) are now properly removed from command output

### Technical
- Enhanced `waitForCompletion` logic with improved sentinel detection algorithm
- Added `findSentinelOutput` method to `SSHSession` class for precise sentinel matching
- Updated buffer processing to handle ANSI escape sequences at the appropriate stage

## [2.2.1] - 2026-04-20

### Added
- **Password prompt protection**: All SSH tools now detect password prompts and block command execution in ALL operation modes to prevent accidental password entry
- **ANSI stripping**: Command output is automatically stripped of ANSI escape sequences before parsing and display
- **Command echo handling**: New `stripCommandEcho` function (disabled by default) provides framework for future echo removal
- **Regex validation**: `ssh-retry` tool now validates user-provided regex patterns and returns clear error messages for invalid patterns
- **Viewer launch mode**: New `VIEWER_LAUNCH_MODE` environment variable (`browser` or `terminal`) controls whether auto‑open launches browser or terminal viewer

### Changed
- **Password prompt handling**: Moved from terminal mode detection to dedicated password prompt check that blocks execution in all modes (safe/full/common)
- **Sentinel marker syntax**: Fixed to `; __MCP_EC=$?; echo` for reliable exit code capture even with command chaining
- **Output cleaning pipeline**: Command output now passes through: ANSI stripping → echo removal → sentinel removal (when enabled)
- **Terminal mode detection**: Safe mode now only blocks editor/pager modes; password prompts are handled separately with clearer error messages
- **Prompt pattern matching**: Updated `DEFAULT_PROMPT_PATTERNS` to match more shell prompt variations reliably

### Fixed
- **Command echo stripping risk**: Disabled automatic echo removal to prevent accidental stripping of multi‑line command output (e.g., Python scripts)
- **Lock release guarantee**: `ssh-run` and `ssh-retry` now use `try...finally` blocks to ensure agent locks are always released even on errors
- **Post‑execution password detection**: Added check after command completion to detect if command left terminal at password prompt
- **Pattern regex errors**: Invalid regex patterns in `ssh-retry` now return user‑friendly error instead of crashing

### Technical
- New helper functions: `stripAnsi`, `stripCommandEcho`, `stripSentinelFromOutput` in `src/index.ts`
- `ssh-run` tool restructured with proper error handling and lock management
- Enhanced terminal mode validation with distinct handling for password prompts vs. editor/pager modes
- `VIEWER_LAUNCH_MODE` configuration added to support both browser and terminal viewer auto‑launch

## [2.0.2] - 2026-04-19

### Added
- **Common mode**: New "common" option in browser terminal dropdown allowing both user and AI to type simultaneously without locking conflicts
- **User lock enforcement**: AI tools (`ssh-run`, `ssh-session-send`, `ssh-session-control`) now respect "user" lock mode and return `INPUT_LOCKED` error when terminal is locked to user

### Changed
- **Dropdown order**: "common" is now the default mode instead of "user"
- **Lock synchronization**: Browser dropdown automatically updates to reflect server lock state
- **Improved waiting logic**: `ssh-run` waits for both command echo and actual output in two phases for better reliability
- **Error messages**: More helpful lock rejection messages guiding users to switch modes

### Fixed
- **UI text consistency**: Updated lock messages and tooltips for new "common" mode
- **Input blocking**: Proper handling of user lock preventing AI input across all relevant tools

## [2.0.1] - 2026-04-19

### Added
- **Smart output truncation**: When `ssh-run` output exceeds `maxChars` (default 16000), shows head (30%) and tail (70%) with clear separator and instructions to read omitted section
- **Omitted section recovery**: Truncation message includes exact offset and command to retrieve omitted data via `ssh-session-read`

### Fixed
- **Increased default buffer**: `ssh-run` default `maxChars` increased from 8000 to 16000 for longer command outputs

## [2.0.0] - 2026-04-19

### Added
- **Shared SSH Terminal**: xterm.js browser terminal with real terminal emulation (replaces text dashboard)
- **WebSocket communication**: Binary PTY output streaming via WebSocket, replacing HTTP polling for terminal pages
- **Input lock mechanism**: User/AI mode switch prevents simultaneous input conflicts
  - Browser dropdown (user/claude/codex) controls who can type
  - AI's `ssh-run` auto-acquires and releases agent lock
  - User input blocked when AI is active, with visual feedback
- **Simplified AI tools**:
  - `ssh-quick-connect`: One-step connect + open terminal, auto-reuses existing sessions
  - `ssh-run`: Execute command and return output, with auto-locking
  - `ssh-status`: Quick status check for active sessions
- **`.env` support**: SSH credentials and config loaded from `.env` file automatically
- **`npm run launch`**: One-command startup (MCP + SSH + browser terminal)
- **CLI management**: `npm run status`, `npm run kill`, `npm run cleanup`
- **rawBuffer**: Independent raw output buffer for WebSocket clients (preserves ANSI/cursor control)
- **Session event subscriptions**: `onRawOutput()` and `onEvent()` for real-time push to WebSocket clients
- **Reconnect without duplication**: WebSocket reconnect sends only incremental data via `rawOffset`
- **Auto-open terminal**: `--autoOpenTerminal` / `AUTO_OPEN_TERMINAL` env var
- **AI Agent Guide**: `AI_AGENT_GUIDE.md` documenting correct AI workflow

### Changed
- Browser terminal pages now use xterm.js (CDN) instead of `<pre>` text rendering
- Old browser pages (`/session/`, `/binding/`) preserved as fallback
- New terminal pages at `/terminal/session/`, `/terminal/binding/`
- Home page now shows "Terminal" button as primary action
- `viewer-cli.ts` supports `--interactive` mode via WebSocket

### Technical
- Added `ws` dependency for WebSocket server
- WebSocket endpoints: `/ws/attach/session/:id`, `/ws/attach/binding/:key`
- Server cleanup now closes all WebSocket connections on shutdown

## [1.0.2] - 2026-04-18

### Added
- Windows helper scripts for single-instance viewer launching and local demo runner workflows
- `ssh-viewer-ensure` and `ssh-viewer-list` MCP tools
- `ssh-session-open` / `ssh-session-watch` support for `includeDashboard`

### Fixed
- PowerShell viewer redraw stacking on Windows terminals
- Viewer exit behavior for `q`, `Ctrl+C`, backend unavailable, and closed-session cases
- Early status output in `open-viewer-window.ps1`
- Faster early failure reporting in `live-viewer.ps1` when the runner exits before becoming ready
- Terminal newline normalization in `SSHSession.write`

## [1.0.1] - 2025-04-16

### Added
- HTTP Viewer server for real-time session monitoring
- New CLI tool `ssh-session-mcp-view` for terminal-based session viewing
- Support for real-time SSH session dashboard display
- Viewer HTTP API endpoints for programmatic access
- Enhanced terminal input normalization and ANSI escape sequence handling

### Technical
- Added viewer-cli.ts for standalone terminal viewer
- Enhanced shared.ts with new utility functions
- Updated package.json with new bin entry
- Node.js >= 18 requirement maintained

## [1.0.0] - 2025-04-16

### Added
- Initial release of SSH Session MCP
- Persistent SSH PTY session management
- Actor-aware input tracking (user/codex/claude)
- Split dashboard rendering
- Session idle timeout and cleanup
- Control key support (Ctrl+C, Ctrl+D, arrow keys, etc.)
- PTY window resizing
- Comprehensive MCP toolset:
  - `ssh-session-open`: Open persistent SSH sessions
  - `ssh-session-send`: Send input to sessions
  - `ssh-session-read`: Read terminal output
  - `ssh-session-watch`: Monitor session changes with dashboard
  - `ssh-session-control`: Send control keys
  - `ssh-session-resize`: Resize PTY window
  - `ssh-session-list`: List current sessions
  - `ssh-session-close`: Close sessions
- Support for SSH key and password authentication
- Configurable session parameters
- Automatic session cleanup for idle and closed sessions
- Test suite with Vitest
- Complete documentation

### Technical
- Built with TypeScript
- Uses Model Context Protocol SDK
- SSH2 library for SSH connections
- Zod for input validation
- Node.js >= 18 requirement
