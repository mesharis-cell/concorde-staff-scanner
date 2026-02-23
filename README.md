# Savvio Staff Scanner (Standalone)

React + TypeScript SPA scanner app for attendee check-in.

## Run locally

```bash
bun install
bun run dev
```

App URL: `http://localhost:4173`

## Build

```bash
bun run build
```

## Configure backend

Set `VITE_API_BASE_URL` in `.env` (or use the API Base input in-app and Save).

Required backend endpoint:

- `POST /api/v1/public/check-in/consume`

Payload:

```json
{ "token": "<jwt>" }
```

## Android install (PWA)

1. Deploy over HTTPS (Netlify/Vercel/Cloudflare Pages).
2. Open app in Chrome Android.
3. Tap `Install on Android` when prompt appears, or use Chrome menu -> `Add to Home screen`.

The app includes:

- `manifest.webmanifest`
- service worker (`public/service-worker.js`)
- 192x192 and 512x512 icons

## Netlify

- Base directory: `staff-scanner`
- Build command: `bun run build`
- Publish directory: `dist`
