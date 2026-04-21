# Acceptance Scenarios

These scenario ids are the minimum regression checklist for the current architecture.

## single-device-default-connection

One device profile is configured, no explicit `session` is passed, and `ssh-quick-connect` plus `ssh-run` target that default path correctly.

## dual-device-single-instance-switch

One MCP instance manages two devices. The active session can be switched safely with `ssh-session-set-active` without cross-target confusion.

## single-device-multi-connection-selection

One device hosts multiple named SSH connections at the same time, and explicit session targeting remains stable.

## multi-ai-multi-instance-isolation

Two AI agents use different `SSH_MCP_INSTANCE` values. Their runtime state, viewer bindings, and active-session defaults do not interfere.

## viewer-port-auto-allocation

`VIEWER_PORT=auto` allocates a free local port, records it, and reports it through viewer/session responses.

## runtime-state-cleanup-on-exit

Closed sessions, stale viewers, and retained runtime metadata are cleaned up without leaving orphaned default-target references.

## input-lock-user-blocks-agent

When the user lock is active, agent write tools fail predictably with `input-locked` semantics instead of racing the shell.

## ambiguous-active-session-blocks-default-targeting

When multiple sessions are eligible and no safe default exists, tools avoid silent mis-targeting and instruct the caller to choose explicitly.
