# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
