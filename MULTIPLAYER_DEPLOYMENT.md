# HyperVanguard: Astral Siege — Multiplayer Deployment

## Architecture

- **Frontend:** Vercel or CrazyGames.
- **Realtime backend:** Hugging Face Docker Space.
- **Transport:** secure WebSocket (`wss://`).
- **Match state:** authoritative on the backend for HP, shields, kills, deaths, respawns, match timer and AI bots.
- **Client prediction:** local movement remains client-predicted for responsive controls; remote players and bots are synchronized from the server.

## 1. Update the Hugging Face backend

Use these files from this project at the root of the Hugging Face Space:

- `server.ts`
- `server/authDatabase.ts`
- `package.json`
- `Dockerfile`
- `README.md`
- `data/` if you want to keep the existing call-sign database

The `README.md` contains the Docker Space metadata:

```yaml
sdk: docker
app_port: 7860
```

The server listens on `0.0.0.0:7860`.

After the Space finishes building, open:

`https://fkdurrani-hypervanguard-backend.hf.space/api/health`

It should return JSON containing:

- `"status": "ok"`
- `"websocket": true`

## 2. Deploy the frontend

Build/deploy the game normally with Vite:

```bash
npm install
npm run build
```

The game already points production multiplayer traffic to:

`wss://fkdurrani-hypervanguard-backend.hf.space`

Local development continues to use the current host WebSocket automatically.

## 3. Multiplayer test

Test with two separate browser profiles/devices so each player has a different local profile/call sign.

1. Open the deployed game in both clients.
2. Open Multiplayer Arena.
3. Wait for both players to enter the queue.
4. If fewer than eight humans are available, use **DEPLOY WITH AI BOTS**.
5. Confirm both clients see the same player positions, shots, HP/shields, kills, deaths and respawns.
6. Confirm the match ends at 10 kills or after 180 seconds.

## Important

Do not use a fake/local offline multiplayer fallback. A fallback would make the game look multiplayer on one browser while other players cannot join the same match. This build only starts multiplayer matches through the real backend.

Hugging Face Spaces can sleep when inactive on free hardware. For production multiplayer, the backend should be kept reliably running; check the Space hardware/sleep settings before launch.
