---
title: HyperVanguard Multiplayer Backend
emoji: 🚀
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
short_description: Authoritative WebSocket multiplayer backend for HyperVanguard
---

# HyperVanguard: Astral Siege — Multiplayer Backend

This Space hosts the game's real-time WebSocket multiplayer backend.

## Endpoints

- `GET /` — backend status
- `GET /api/health` — health and room statistics
- `wss://<space>.hf.space` — WebSocket multiplayer endpoint

The frontend can be hosted separately on Vercel or CrazyGames and connects to this Space over secure WebSockets.

## Deployment

Use Docker Space with port `7860`. The server binds to `0.0.0.0` and supports WebSocket connections.

For production multiplayer, keep the Space running reliably. Hugging Face documents that free CPU Spaces can sleep after inactivity; upgraded hardware can be configured to remain running. Persistent storage is not required for active match state, because rooms are intentionally held in memory.
