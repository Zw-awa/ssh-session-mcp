# Failure Taxonomy

`ssh-session-mcp` uses a small set of normalized failure categories so AI agents can react consistently without depending on one-off error strings.

| Category | Meaning | Typical Recovery |
|------|------|---------|
| `config-error` | Config file missing, invalid, or self-contradictory | Fix config, choose the right scope, or pass `--config` |
| `environment-missing` | Required env var, binary, or runtime path is unavailable | Fill env, install dependency manually, or change host setup |
| `auth-failure` | SSH authentication failed | Fix password/key or device auth settings |
| `connection-failure` | Network or SSH transport could not connect or stay healthy | Retry, inspect host/port, or verify board reachability |
| `ambiguous-session` | More than one candidate session exists and default targeting is unsafe | Use `ssh-session-set-active` or pass `session` explicitly |
| `input-locked` | The session is locked to the other actor | Wait for the user or switch lock ownership in the viewer |
| `terminal-state-abnormal` | Terminal is in password prompt, editor, pager, or another unsafe state | Recover the shell before sending more commands |
| `viewer-unavailable` | Viewer could not be opened, attached, or reused | Reopen viewer or inspect local viewer state |
| `runtime-state-abnormal` | State files, active-session binding, or tracked command state is stale/inconsistent | Use diagnostics, cleanup, or reopen the session |
| `policy-blocked` | Safe mode or a hard safety rule intentionally blocked the command | Ask the user, switch mode, or choose a safer command |

## Guidance

- Prefer `resultStatus` first, then `failureCategory`.
- Do not pattern-match entire prose error strings when `failureCategory` is present.
- Treat unknown failures as plain tool-specific errors and surface them to the user.
