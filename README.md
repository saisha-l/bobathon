# BOB, WYD?

Real-time workplace presence app. Coworkers share status, mood, and music via 6-digit squad codes.

## Quick Start

```bash
# 1. Start backend
cd backend
npm install
npm start
# → http://localhost:3001

# 2. Open frontend
open frontend/index.html
```

## Stack

- **Backend** — Node.js, Express, ws (WebSockets), Spotify OAuth
- **Frontend** — Vanilla HTML/CSS/JS (no framework, no build step)

## Features

- Create / Join squads with 6-digit codes
- Real-time presence via WebSocket (status, mood, Spotify)
- Spotify "Now Playing" — real OAuth, album art, progress bar
- Daily Poll with live vote tallying
- Grouped member cards (lunch crew, meeting crew, etc.)
- 24h squad expiry with creator-extend
- Auto-reconnect WebSocket

## API

See [README.md](README.md) for full REST + WebSocket documentation.
