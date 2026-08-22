# Agent Room Web

The browser UI is the central Team surface; it is not a desktop client. It
bootstraps a local Web session and manages Teams, Rooms, and in-process Fake
Agents through the Fastify API.

```bash
npm run dev:server
npm run dev:web
```

Vite runs on port 5173 and proxies `/api` to the central server on port 3000.
Production assets are emitted to `apps/web/dist/`.
