# WEB-061: Collaboration and Management Product Navigation

Date: 2026-08-31. Boundary: existing Central Web, under
[ADR-0034](../adr/0034-separate-collaboration-and-management.md). No backend API,
client, deployment configuration, running installation or Release changed.
The implementation starts at `41e9a8c`; this record accompanies its final
responsive-layout, dialog-focus and error-presentation refinements.

## Delivered Behavior

Collaboration contains the default Workbench, Task details and Room conversation.
Management contains separate Agent and Device inventories, Team and members,
and Account and security. A shared sidebar becomes compact navigation on narrow
screens. Configuration no longer stretches the conversation page into a long
setup form. Account preferences and installation-Owner recovery remain reachable
without a selected Team.

Agent inventory supports search, status and integration filters. Creation is
explicit; viewing a Hosted Agent mounts only that profile, without another
creation form or other Agents' configuration. Local Agents link to their Device
instead of exposing a Central runtime editor. Device authorization and Agent
readiness are distinct labels. Pairing, invitation and recovery are opened on
demand. Hosted execution remains HTTP-only and does not operate the computer.

Returning from Management restores the same-session, same-Team Collaboration
location, including Task, detail tab and Work filters. Existing Room controllers
continue to own draft and outbox recovery. Team or identity changes cannot
restore another context. Late setup responses after close or context changes
cannot repopulate invitation or credential output. Dialogs contain keyboard
focus, refocus after setup-step transitions, report setup failures inside the
active surface and restore trigger focus on close.

## Regression Evidence

The final Web suite has 246 passing tests, up from the 227-test baseline.
Existing navigation, auth, pairing, Hosted and recovery assertions were adapted
to explicit navigation and on-demand forms rather than weakening authority
checks. Coverage includes:

- Work Task/tab/search and Room Task/draft round trips through Management;
  browser history, management deep links and authorized resource restoration.
- Account settings without a Team, Team changes and session invalidation.
- Inventory-only rendering, search/filter results and disabled-versus-ready
  status; no eager Hosted configuration or pairing reads.
- Single-profile editing, creation on demand, transient API-key clearing and
  ordinary-member denial of Hosted configuration controls.
- Device authorization versus readiness, owner/member pairing and revoke
  visibility, and local detail without a Central runtime editor.
- Late MCP setup responses after dialog close and Team changes; dialog focus
  after step transitions and setup errors inside the active dialog.

## Real Browser Evidence

The production Web build was served by the disposable product-experience
preview on isolated loopback endpoints. Only synthetic Team data, credentials
and provider responses were used. No real installation or paid provider was
contacted.

An installation Owner navigated the new surfaces, created a Central Hosted
Agent with explicit Room access, opened its Room and received the synthetic
provider's reply through actual HTTP. A typed Room draft and selected Task
survived visiting Device management and returning to Collaboration. Device
pairing was explicitly opened, created and cancelled; no physical Device was
claimed. Team invitation was opened and closed without issuing an invitation.
Account preferences were changed; no recovery key was generated or replaced.

Chinese/dark and English/light views were inspected at desktop 1280 x 800,
720 x 900 and 390 x 844. Measured document width matched viewport width in the
checked layouts. The 390-pixel header remains on one compact row with sign-out
available. Search occupies its own row above two filters. Hosted dialogs remain
within the viewport and scroll internally; the profile view contains only the
selected Agent. Shift-Tab stays inside the dialog, Escape closes it, the trigger
regains focus and the background leaves its inert state. No warning or error
console entries were observed in the final browser session.

- [Chinese desktop conversation](assets/web-061/zh-room-desktop.jpg)
- [English light desktop Agent inventory](assets/web-061/en-agents-desktop.jpg)
- [Chinese dark mobile Agent inventory](assets/web-061/zh-agents-390.jpg)
- [English light mobile Hosted profile](assets/web-061/en-profile-390.jpg)
- [English light 720-pixel account settings](assets/web-061/en-account-720.jpg)

These screenshots contain only synthetic fixture data, not API keys, pairing
codes or real user messages. The preview and temporary browser tab were closed,
and the browser viewport override was reset after verification. The preview
owns disposal of its temporary databases on shutdown.

## Verification Commands and Results

Run from the repository root with Node.js 22. Use a task-scoped writable
`GOCACHE` when the shared cache is unavailable.

```sh
npm test
npm run test:e2e
npm run build
npm run validate
npm run lint:docs
git diff --check
```

Final `npm test`: 728 pass, 0 fail: 352 Server, 246 Web, 14 Contracts,
54 embedded Bridge UI, 45 QA evidence, 2 product-experience and 15 website
checks. Generated contract/type and Go contract checks also pass.
Deterministic cross-process E2E: 6 pass, 0 fail; the explicitly opt-in real
Codex/Pi provider scenario is skipped. Production builds and 9 schemas with
133 fixtures pass. Maintained Markdown and whitespace checks pass.

The existing Vite bundle-size advisory remains non-blocking; this change does
not claim bundle splitting or performance benchmarking. Browser acceptance was
performed with an Owner session; ordinary-member negative coverage is automated.
No claim is made about live-provider acceptance, physical Windows/macOS client
acceptance, release CI, a production upgrade or publication of a new version.
The running stable installation is not updated by these commits.
