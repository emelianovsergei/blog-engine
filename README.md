# blog-engine

Universal weekly blog **topic-selection** engine shared by the PRO MAX and PULSE
Sacramento HVAC websites.

Each week the engine:

1. Pulls live Sacramento weather (Open-Meteo — no API key) and classifies a
   headline anomaly: `heat-wave`, `cold-snap`, `wildfire-smoke`, `storm`, or `none`.
2. Asks Gemini for several candidate topics aligned to the season and weather.
3. Rejects semantic near-duplicates of existing posts (Gemini embeddings + cosine
   similarity).
4. Ranks the survivors (dedup distance + category rotation + weather fit) and
   returns the winner.

The result maps directly onto each site's existing `planPost` seed shape — the
engine selects *what to write about*; article writing, images, and publishing
stay in each site's `scripts/generate-blog-post.ts`.

## Usage

```ts
import { GoogleGenAI } from "@google/genai";
import {
  selectWeeklyTopic,
  SACRAMENTO_LOCATION,
  HVAC_APPLIANCE_CATEGORIES, // PRO MAX
  HVAC_CATEGORIES,           // PULSE
} from "blog-engine";

const topic = await selectWeeklyTopic({
  config: {
    businessName: BUSINESS_NAME,
    serviceAreas: SERVICE_AREAS,
    location: SACRAMENTO_LOCATION,
    categories: HVAC_APPLIANCE_CATEGORIES, // <- the only per-site difference
  },
  existingPosts,
  now: new Date(),
  gemini: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
});
// topic.topic / topic.notes feed planPost as the seed.
```

## Install (as a Git dependency)

```jsonc
// package.json
"dependencies": {
  "blog-engine": "github:emelianovsergei/blog-engine#v0.1.0"
}
```

The package ships its build via a `prepare` script, so a normal `npm install`
of the Git dependency produces a working `dist/`.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node:test unit tests (no network)
```
