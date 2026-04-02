# TrendReader

Upload any Excel or CSV. State your analytical objective. Get structured trends, anomalies, and investigation flags powered by Claude.

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Set your API key
cp .env.example .env
# Edit .env with your Anthropic API key

# 3. Run
npm run dev
```

Open `http://localhost:3000`

## How It Works

1. **Upload** — Drop an .xlsx, .xls, or .csv file
2. **Preview** — Confirm your data parsed correctly
3. **Objective** — Tell the engine what you're trying to understand
4. **Analysis** — Claude returns structured findings: trends, anomalies, and investigation flags, color-coded by severity

## Roadmap

- [x] Sprint 1: Data ingestion + initial analysis
- [ ] Sprint 2: Continuous chat (drill-in, follow-ups, scenarios)
- [ ] Sprint 3: Charts on demand (Recharts inline rendering)
- [ ] Sprint 4: Web enrichment layer (external context via search)

## Stack

- React 18 + Vite
- SheetJS (xlsx) for file parsing
- Anthropic Claude API (Sonnet) for analysis
