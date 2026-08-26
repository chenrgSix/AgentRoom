# BRG-037 Bridge Usage Guide Acceptance

## Scope

`BRG-037` renames the paired desktop sidebar entry from **Codex 会话说明** to
**使用说明**. The same modal now starts with a short explanation of Bridge and
its Overview, Agents, and Settings destinations. Existing Codex Task, Run,
native-session reuse, recovery codes, and separate-App-Server guidance remains
inside an explicit **Codex 会话说明** section.

The two selection-scoped Codex configuration warnings continue to open the
same guide. No authenticated Console route, configuration payload, pairing
identity, Runtime command, Workspace policy, or credential behavior changes.

## Evidence

- The embedded Console test requires the general entry, title, introduction,
  daily-use steps, Codex section, and accessible close label together with all
  previous Codex recovery and daemon statements.
- `npm run test:bridge-ui` passes all 21 presentation and modal-controller
  checks, including Escape handling and exact focus restoration.
- Focused Go Console tests pass with the updated embedded assets.
- `npm run lint:docs` and `git diff --check` pass.
- The isolated paired browser fixture exposes **使用说明** in the sidebar; the
  dialog opens as **AgentRoom Bridge 使用说明**, shows ordinary navigation first,
  and retains **Codex 会话说明** and both safe recovery codes without horizontal
  overflow or browser console errors.
- A local packaged macOS app is installed and inspected separately after the
  commit. That install check verifies the committed version and real Wails
  WebView; it is not public release evidence.
