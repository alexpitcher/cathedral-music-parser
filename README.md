# Leicester Cathedral Songmen Service Parser

Minimal text service that outputs only Leicester Cathedral "Songmen" services parsed from the latest Music List PDF.

## Quick Start

```bash
npm install
npm start
```

Service runs on `http://localhost:3000`

## Environment Variables

- `PORT` - Server port (default: 3000)
- `MUSIC_LIST_URL` - Leicester Cathedral music list page (default: https://leicestercathedral.org/music-list/)

## Endpoints

All endpoints default to `text/plain; UTF-8` except `/json`:

- **GET /songmen/next** → Single line: `YYYY-MM-DD HH:MM    |  |  `
- **GET /songmen/week** → Multiple lines for current ISO week (Mon-Sun)
- **GET /songmen/raw** → Raw parsed lines for Songmen services (debugging)
- **GET /status** → Health snapshot with source URLs, dates, and stale status
- **GET /json** → JSON format for next qualifying service

## Headers

All endpoints include:
- `X-Source-End-Date: YYYY-MM-DD`
- `X-Last-Fetch: ISO8601`
- `X-Stale: true|false`

## Staleness

When the music list expires and no newer PDF is available:
- `/songmen/next` returns: `STALE: Music list ended YYYY-MM-DD — no newer list published.`
- `/songmen/week` starts with the stale banner, then no items
- `/status` reports `stale: true`

## Testing

The service automatically discovers and parses the latest PDF from Leicester Cathedral's music list page. It refreshes every 12 hours and filters for services containing "Songmen" (case-insensitive, including mixed formations like "Boys and Songmen").

## Development

```bash
npm run dev  # Auto-restart on changes
```

The service handles multi-column PDFs, Unicode normalization, ligature mapping, and robust time/date parsing. Organ pieces are excluded from text output but included in JSON under `pieces.organ`.