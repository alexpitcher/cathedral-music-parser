# Leicester Cathedral Songmen Service Parser

Minimal text service that outputs only Leicester Cathedral "Songmen" services parsed from the latest Music List PDF.

## Quick Start

```bash
npm install
# Run against live site
npm start

# Or run against a local fixture PDF with a mock date
MOCK_DATE=2025-09-01 MUSIC_LIST_PDF_PATH=./music-list.pdf npm start
```

Service runs on `http://localhost:3000`.

## Environment Variables

- `PORT` - Server port (default: 3000)
- `MUSIC_LIST_URL` - Leicester Cathedral music list page (default: https://leicestercathedral.org/music-list/)
- `MUSIC_LIST_PDF_PATH` (or `FIXTURE_PDF_PATH`) - Path to a local PDF fixture. When set, discovery is skipped and the local PDF is parsed.
- `MOCK_DATE` - Mock current instant. Accepts `YYYY-MM-DD` (interpreted as 12:00Z) or a full ISO datetime like `2025-09-07T10:00:00Z`. Useful for testing selection right before/after services.

## Endpoints

All endpoints default to `text/plain; charset=utf-8` except JSON paths:

- **GET /songmen/next** → Human-readable block for the next qualifying service:
  - First line: `YYYY-MM-DD HH:MM  <Service>`
  - Then: `Choir: …`, and present categories on their own lines: `Settings: …`, `Anthems: …`, `Psalms: …`, `Hymns: …`
- **GET /songmen/week** → Human-readable blocks for current ISO week (Mon–Sun)
- **GET /songmen/tomorrow** → Human-readable blocks for tomorrow's services
- **GET /songmen/day[?date=YYYY-MM-DD]** → Human-readable blocks for the specified day (defaults to today)
- **GET /songmen/raw** → Raw parsed lines for Songmen services (debugging)
- **GET /status** → Health snapshot with source URLs, dates, and stale status
- **GET /json/next** → JSON for next qualifying service (also available at `/json` for back-compat)
- **GET /json/week** → JSON array for current ISO week (Mon–Sun)

Example (/songmen/next)

```
2025-09-15 17:30  Choral Evensong
Choir: Senior Girls & Songmen
Settings: Mag and Nunc in D minor — Walmisley; Responses — Moore
Anthems: Crux fidelis — MacDonald
Psalms: Psalm 110 — Garrett; Psalm 150 — Stanford
Hymns: Hymns 707, 421, Mungu ni mwema, 806
```

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

To point tests at a local fixture PDF instead of the live site, set `MUSIC_LIST_PDF_PATH` to the file path and optionally `MOCK_DATE` to control the current date in logic. Example:

```bash
MOCK_DATE=2025-09-02 MUSIC_LIST_PDF_PATH=./music-list.pdf npm start
```

## Docker

```bash
# Build + run with Docker
docker build -t cathedral-music-parser:local .
docker run --rm -p 3000:3000 cathedral-music-parser:local

# Or via Docker Compose
docker compose up --build

# With a local fixture PDF and a mock date
docker run --rm -p 3000:3000 \
  -e MUSIC_LIST_PDF_PATH=/data/music-list.pdf \
  -e MOCK_DATE=2025-09-01 \
  -v $(pwd)/music-list.pdf:/data/music-list.pdf:ro \
  cathedral-music-parser:local
```

## CI / Images

- A GitHub Action builds and publishes images to GHCR on push to `main`/`master` and tags.
- Image name: `ghcr.io/<owner>/<repo>:<tag>` (branch, semver tag, or SHA).
- You can pull and run the published image similarly to the local Docker example above.

## Development

```bash
npm run dev  # Auto-restart on changes
```

The service handles multi-column PDFs, Unicode normalization, ligature mapping, and robust time/date parsing. Organ pieces are excluded from text output but included in JSON under `pieces.organ`.
