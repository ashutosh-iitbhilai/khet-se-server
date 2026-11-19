# Khet Se — Algorithm Verification (Durg–Bhilai)

**Date:** 20 Nov 2026
**Tools:**
- `npm run seed:algo`: the test bed
- `npm run algo:check`: the independent checker
- `test/sellable.test.ts`: regression tests

## What is checked, and how

The checker loads the raw database. For every test customer, it calculates **independently** what the API should return:
- its own great-circle distance maths (Earth radius 6378.1 km, as MongoDB uses);
- its own implementation of the eligibility rules and scoring formulas.

It then compares that against the running API.

| Check | Rule |
|---|---|
| Eligibility (listings and farms) | Active listing with stock for at least one minimum order; not expired (dry) and within shelf life (fresh); farm active with delivery on; farmer's account active and profile not rejected; customer inside the farm's own delivery radius and inside the search radius |
| Distances | Within 50 m of the great-circle distance |
| Radius widening | Starts at 8 km; widens 15 → 25 km only while there are fewer than 8 listings (or 4 farms) |
| Scores | Each part (proximity, freshness, stock, Bayesian rating, price within like-for-like items, organic) and the weighted total |
| Sort orders | Distance, price ↑↓, freshness, farms by distance; "recommended" = score order with the same-farm diversity penalty (0.85ⁿ) |
| Diversity | The first 8 recommendations span at least 3 farms when that many exist |
| Filters | Organic shows only farms with a verified certificate; max price |
| Checkout | Shown ⇔ orderable for every nearby listing (same rules in search and checkout); delivery fee = ₹20 + ₹3/km (rounded up), max ₹60, free above ₹300 |
| Data | Each listing's stored location equals its farm's location |

## Test bed: real places

Coordinates for 22 localities and 10 villages were looked up in OpenStreetMap (Nominatim, through the app's own `/api/geo/search`) and saved in `src/scripts/data/durg-bhilai.places.json`.

- **Localities:** Bhilai Sectors 1/4/7/9, Supela, Nehru Nagar, Smriti Nagar, Kohka, Junwani, Risali, Maroda, Bhilai-3, Power House, Khursipar, Kurud, Durg Junction, Bhilai Nagar, Jamul, Borsi, IIT Bhilai (Kutelabhata), Kumhari, Ahiwara.
- **Villages:** Utai, Dhamdha, Patan, Machandur, Somni, Murmunda, Kachandur, Khapri, Jewra Sirsa, Jamgaon.

**21 farms (59 listings).** Each farm tests a specific rule:
- **Ranking:** three tomato farms side by side at Utai (cheap, fresh, organic, highly rated vs dear, poorly rated vs unrated).
- **Delivery-area edge:** a 3 km farm at Khapri, with test customers at 2.8 / 2.95 / **3.03** / 3.05 / 3.2 km.
- **Radius widening:** far farms at Patan, Kachandur and Dhamdha.
- **Diversity:** a farm with 10 listings.
- **Must never be shown:**
  - an expired dry product and stale spinach
  - a farm with delivery switched off
  - an inactive farm
  - a suspended farmer
  - sold-out and paused listings

**27 customers:** one per locality, plus the 5 edge points.

## Results

### First run: 4 problems found

| # | Problem | Impact | Fix |
|---|---|---|---|
| 1 | **Expired and stale produce was offered.** A sun-dried tomato pack 30 days past expiry, and spinach harvested 6 days ago (3-day shelf life), appeared in search, farm lists and farmer profiles, and could be ordered. Freshness only lowered the score to 0. | Customers could buy expired food. | One shared rule (`recommendation/sellable.ts`) used by search, farm lists, product pages, farmer profiles and checkout. Checkout explains "past its expiry date / shelf life". |
| 2 | **Shown but impossible to order.** A listing with 0.5 packets left and a 1-packet minimum appeared in search. Search only required stock above 0. | Dead ends at checkout. | Search requires stock ≥ minimum order. |
| 3 | **Edge disagreement.** Checkout rounded the distance to 0.1 km before comparing it with the delivery radius. At 3.00–3.05 km from a 3 km farm, it would accept an order that search hid. | Inconsistent behaviour at the boundary. | Checkout compares the exact distance; the rounded figure is only for display and fees. |
| 4 | **Price score skewed** next to the expired spinach: its low price set the cheapest end of the range. | Ranking slightly off. | Fixed by #1. |

The test-bed lookup also showed that some earlier hand-placed **demo** coordinates were 5–7 km off (Utai, Dhamdha, IIT Bhilai). They now use the OpenStreetMap coordinates.

### After the fixes: all checks pass

| Check | Passed |
|---|---|
| Checkout: shown ⇔ orderable | 734 |
| Checkout: delivery fee rule | 563 |
| Distances (listings / farms) | 525 / 163 |
| Scores: each part / total | 525 / 525 |
| Data: listing location = farm location | 124 |
| Eligibility, radius widening, every sort order, diversity, filters | 27 each (one per customer) |
| **Total** | **3,469 checks, 0 failures** |

Regression tests for problems 1–3 are in `test/sellable.test.ts` and run with `npm test`.

## Run it

```bash
npm run seed:catalogue        # once
npm run seed:algo             # the Durg–Bhilai test bed
npm run dev                   # the API, in another terminal
npm run algo:check            # waits ~60 s for cached results to expire, then checks
npm run seed:algo -- --reset  # remove the test bed
```

The checker exits non-zero if anything fails, so it can run in CI against a seeded database.
