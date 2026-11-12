# Search performance (change `search`, task 4.1)

Measured on 2026-11-12 against the local Docker Compose stack.

## Dataset

The default seed was extended to a representative million-post corpus:

| Metric | Value |
|---|---:|
| Topics | 101,014 |
| Posts | 1,004,316 |
| Synthetic posts | 1,000,000 across 100,000 topics |
| Seeded posts | 4,316 |
| Database size | 1,401 MB |

The synthetic rows were inserted with `generate_series` (100,000 topics × 10 posts) and the
tables were `ANALYZE`d. They deliberately repeat all common benchmark words in every body, so
every query matches almost the whole table — a worst case for ranking. The seeded English,
Spanish and French rows remain in place.

## Command

```bash
docker compose up -d --build --wait
bun run search:benchmark
```

`search:benchmark` requests the full server-rendered `/search?q=<query>&kind=posts` page with
30 samples and 5 warm-ups per query, using a fresh guest identity per request so the search
flood interval does not affect latency. It fails when any p95 exceeds the task's 300 ms target.

## Results

| Query | p50 (ms) | p95 (ms) | p99 (ms) | Result |
|---|---:|---:|---:|---|
| `favourite` | 77.15 | 95.44 | 100.28 | PASS |
| `reading` | 79.32 | 101.78 | 233.59 | PASS |
| `editor` | 86.85 | 106.75 | 130.98 | PASS |
| `weekend` | 81.44 | 189.24 | 236.58 | PASS |
| `question` | 81.54 | 116.32 | 160.70 | PASS |

All common queries are under the 300 ms target at one million posts. Ranking runs over at most
the 10,000 most recent matches (`SEARCH_CANDIDATE_CAP`), while the result set still has the
1,000-hit cap; this keeps a term that matches the whole corpus bounded.

## Seed language samples

After the same start, a guest search in each language returns seeded content (the `bp`
preference cookie selects the guest locale):

```bash
curl -H 'Cookie: bp=en.1.system' '…/search?q=favourite&kind=topics' # seeded English topic
curl -H 'Cookie: bp=es.1.system' '…/search?q=semana&kind=topics'    # seeded Spanish topic
curl -H 'Cookie: bp=fr.1.system' '…/search?q=nouvel&kind=topics'    # seeded French topic
```

The seed writes the text-search configuration per topic and post from the generated locale,
so stemming works in English, Spanish and French rather than only exact matches.
