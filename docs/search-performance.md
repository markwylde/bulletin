# Search performance (change `search`, task 4.1)

Measured on 2026-11-12 against the local Docker Compose stack with the large seed:

```bash
SEED_SIZE=large docker compose down -v
SEED_SIZE=large docker compose up -d --build --wait
bun run search:benchmark
```

Dataset after the large seed: **2,614 topics**, **10,950 posts**, with 2,280 English,
172 Spanish and 158 French topic indexes (the rest are moved-topic stubs).

The benchmark measures the full server-rendered `/search?q=<query>&kind=posts` page with
30 samples and 5 warm-ups per query. It fails when any p95 exceeds the task's 300 ms target.

| Query | p50 (ms) | p95 (ms) | p99 (ms) | Result |
|---|---:|---:|---:|---|
| `favourite` | 10.18 | 13.86 | 14.03 | PASS |
| `reading` | 13.76 | 19.01 | 21.30 | PASS |
| `editor` | 13.92 | 24.27 | 27.64 | PASS |
| `weekend` | 13.03 | 15.21 | 16.88 | PASS |
| `question` | 8.64 | 12.05 | 12.41 | PASS |

All common queries are well under the 300 ms target.

## Seed language samples

After the same `SEED_SIZE=large` start, a guest search in each language returns seeded content
(the `bp` preference cookie selects the guest locale):

```bash
curl -H 'Cookie: bp=en.1.system' '…/search?q=favourite&kind=topics' # topic:2599
curl -H 'Cookie: bp=es.1.system' '…/search?q=semana&kind=topics'    # topic:2318
curl -H 'Cookie: bp=fr.1.system' '…/search?q=nouvel&kind=topics'    # topic:2426
```

The seed writes the text-search configuration per topic and post from the generated locale,
so stemming works in English, Spanish and French rather than only exact matches.
