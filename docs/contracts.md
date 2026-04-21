# Tool Response Contract

`ssh-session-mcp` keeps existing MCP tool payloads compatible, and adds a lightweight cross-tool contract for agents that need predictable automation.

## Contract Fields

Every JSON-style tool response may include these top-level fields:

| Field | Type | Meaning |
|------|------|---------|
| `resultStatus` | `success` \| `partial_success` \| `blocked` \| `failure` | Normalized outcome for automation |
| `summary` | `string` | One-line human and agent readable summary |
| `failureCategory` | `string` | Present when the result is blocked or failed |
| `nextAction` | `string` | Most useful follow-up action |
| `evidence` | `string[]` | Short supporting facts, ids, ports, session refs, counts |

## Compatibility Rule

- Existing fields such as `status`, `session`, `terminalUrl`, `exitCode`, `completionReason`, `async`, and `commandId` remain unchanged.
- `resultStatus` is used instead of reusing `status`, because some existing payloads already use `status` for command lifecycle values such as `running` or `completed`.
- Tools that return plain text only are not forced into this contract.

## When To Read Which Field

- Use `resultStatus` for cross-tool branching.
- Use tool-specific fields for detailed handling.
- Use `failureCategory` to decide whether to retry, ask the user, or switch sessions.
- Use `nextAction` as the default recovery hint.

## Example

```json
{
  "session": "board-a/main",
  "terminalUrl": "http://127.0.0.1:8793/terminal/session/board-a%2Fmain",
  "resultStatus": "success",
  "summary": "Connected to board-a/main and ensured a viewer.",
  "nextAction": "Use ssh-run to execute the next command.",
  "evidence": [
    "device=board-a",
    "connection=main",
    "viewerMode=browser"
  ]
}
```

## Scope Boundary

This contract standardizes transport/runtime responses only. Board-specific workflows, ROS prompts, dataset orchestration, or device-role knowledge should stay in separate prompts, skills, or companion repos.
