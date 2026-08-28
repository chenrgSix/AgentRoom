# ConveneWire Web

The browser UI is the central Team surface; it is not a desktop client. It
supports the compatible local bootstrap flow and the `trusted-team` Web flow
with secure Cookie sessions, Owner recovery, and one-time member invitations.
After authentication it manages Teams, Rooms, and Agents through the Fastify
API.

```bash
npm run dev:server
npm run dev:web
npm run test --workspace @convene-wire/web
```

Vite runs on port 5173 and proxies `/api` to the central server on port 3000.
Production assets are emitted to `apps/web/dist/`.

Web tests render both identity modes in JSDOM. They cover local onboarding,
trusted Owner setup/recovery, URL-fragment invitation claim, Cookie request
credentials, member invitation creation, and logout.
