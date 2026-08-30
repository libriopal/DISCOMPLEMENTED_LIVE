# Cohere cost vs. revenue per pipeline run

**Written 2026-08-27.** Internal. Nothing here is customer-facing copy: it rests
on the placeholder prices in `packages/shared/src/constants.ts`, which ground
rule 4 marks as provisional, and on 37 production runs by two users — a sample
small enough that the _direction_ of each finding is solid and the second
decimal place is not.

## What it costs

Cohere bills a production key in dollars per token, not in "credits" — the
credit ledger in this repo is our own unit, and the two are unrelated.

Cohere no longer publishes current-generation per-token rates on
cohere.com/pricing (only legacy models and Model Vault instance rates). Third-party
aggregators put both `command-a-03-2025` and `command-a-plus-05-2026` at
**$2.50/M input, $10.00/M output**, which matches the last published rate for
Command R+ 08-2024. Every dollar figure below uses that pair. **Confirm it with
Cohere before pricing anything on it.**

Measured from `pipeline_steps` in the production D1 (`bicameral`), summed per
run — not from `pipeline_runs.total_tokens_*`, which undercounts (a `deployed`
run averages 9,016 input tokens by step sum and 5,532 by the run column; the
run columns are not being written for every step).

| Run outcome         |   n | avg steps | avg in | avg out | Cohere cost |
| ------------------- | --: | --------: | -----: | ------: | ----------: |
| `deployed`          |   4 |       5.0 |  9,016 |   5,445 |  **$0.077** |
| `awaiting_approval` |   4 |       2.0 |  5,890 |   2,876 |     $0.0435 |
| `error`             |  26 |       2.9 |  3,320 |   1,532 |     $0.0236 |
| `paused`            |   2 |       3.0 |  2,756 |   1,469 |     $0.0216 |

Worst observed completed run: 16,952 in / 10,871 out = **$0.151**.

Per-agent averages on `command-a-03-2025` (input / output): researcher
2,012/962 · auditor 1,892/634 · verifier 1,426/352 · designer 1,275/702 · coder
1,438/2,066 · architect 653/201. The coder on `command-a-plus-05-2026` measured
3,344/2,909 — about 2.3× the input and 1.4× the output of the same step on
Command A, so an enterprise run costs meaningfully more than the table above.

Across all 37 runs Cohere spend was **$1.14 for 4 deployed apps** — about
**$0.285 of Cohere per app actually delivered**, because failed runs still burn
tokens. That ratio, not the $0.077, is the number a price has to clear today.

Not included, and unquantified: Embed v4 and Rerank v4 calls in the research
phase, and the Tavily/Scite/You.com research calls, which are billed separately
and per-plan. They are small next to chat but they are not zero.

## What it earns

`routes/pipeline.ts:152` debits `CREDIT_COSTS.generation` — **10 credits, once,
at run start**, covering all five agents, the coder step, and any retries. A
single-shot generation (`routes/generate.ts`) debits the same 10.

### Credit packs — thin, and negative at the top pack

| Pack   | Credits | Price | $/credit | Revenue per run | vs. $0.077 avg | vs. $0.151 worst |
| ------ | ------: | ----: | -------: | --------------: | -------------: | ---------------: |
| test   |     100 |    $1 |  $0.0100 |          $0.100 |        +$0.023 |          −$0.051 |
| small  |     500 |    $5 |  $0.0100 |          $0.100 |        +$0.023 |          −$0.051 |
| medium |   2,500 |   $20 |  $0.0080 |          $0.080 |        +$0.003 |          −$0.071 |
| large  |  10,000 |   $70 |  $0.0070 |          $0.070 |    **−$0.007** |          −$0.081 |

The largest pack is **already negative on an average run**, before any failed
runs, before Embed/Rerank, and before Cloudflare. Every pack is negative on a
worst-case run. And none of them covers the $0.285 all-in cost per delivered
app.

### Subscriptions — negative by an order of magnitude

| Tier | Price |  Grant/mo | Runs in grant | Revenue/run | Cost if grant is spent |    Cost at the daily cap |                                Break-even |
| ---- | ----: | --------: | ------------: | ----------: | ---------------------: | -----------------------: | ----------------------------------------: |
| free |    $0 |     1,000 |           100 |           — |                  $7.70 |                    $7.70 |                                         — |
| pro  |   $29 |    50,000 |         5,000 |     $0.0058 |                   $385 |       $116 (50/day × 30) |    377 runs (3,766 cr, **7.5%** of grant) |
| team |   $99 |   200,000 |        20,000 |     $0.0050 |                 $1,540 |      $462 (200/day × 30) | 1,286 runs (12,857 cr, **6.4%** of grant) |
| ent. |     ? | 1,000,000 |       100,000 |           — |            **$7,700+** | unbounded (no daily cap) |                                         — |

**This is the negative-revenue finding.** It is not in the packs, it is in the
tier grants: a Pro subscriber goes underwater after spending 7.5% of what they
were granted, and the daily cap — the only thing bounding the loss — still
allows $116 of Cohere spend against $29 of revenue. Team is the same shape.
Enterprise has no daily cap at all and no price in the repo; if the 1M-credit
grant stands, an enterprise contract has to start above **$7,700/mo** just to
break even on Cohere, more once the A+ premium on the coder is counted.

A free account can consume $7.70 of Cohere and pay nothing, which is a
deliberate acquisition cost — but it is 77× the cost of a run, so it needs to
be sized against a real conversion rate, not left at a round number.

## What to change

These are recommendations, not applied edits — pricing is Johnathan's call and
ground rule 4 keeps it provisional until a human sets it.

1. **Raise `CREDIT_COSTS.generation` from 10 to 20–25.** At 20 credits the
   worst-case run clears every pack ($0.14–$0.20 revenue vs. $0.151), which is
   the first time the packs stop being a coin flip. At 25 the margin also
   absorbs the failed-run overhead ($0.175–$0.25 vs. $0.285 all-in — still
   short, so this needs the failure rate to come down too, see below).
2. **Cut the tier grants to something near break-even.** At 20 credits/run:
   Pro's break-even is ~7,500 credits (grant today: 50,000) and Team's is
   ~25,700 (grant today: 200,000). Grants roughly 7% of their current size are
   what $29 and $99 actually buy.
3. **Price enterprise, or cap it.** Either put a floor under the contract
   (≥$7,700/mo at the current grant) or give the tier a daily cap like every
   other tier. Right now it is the only unbounded-loss path in the product.
4. **Charge for what a run actually spends.** One flat debit at run start
   charges a 2-step run that errored out the same as a 5-step run that
   deployed, and charges a coder retry nothing at all. Debiting per completed
   step — or truing up at run end against `tokens_in`/`tokens_out`, which are
   already recorded per step — makes the revenue track the cost instead of
   averaging over it.
5. **The failure rate is a cost line.** 26 of 37 runs errored, and those errors
   are 54% of all Cohere spend. Every point of reliability recovered is margin;
   the quota cap that caused much of it is fixed as of d826415, so this number
   should be re-measured before it is priced around.

## Model choice, for the record

`command-a-03-2025` costs the same per token as the capped models it replaced
($2.50/$10), so the 2026-08-27 switch is cost-neutral and buys back the
1,000-calls-a-month ceiling. There is no cheaper option that is safe here:
`command-r7b-12-2024` is $0.0375/M in, $0.15/M out — about 1/67th the price —
but it is banned for the coder because it emits 25-byte stub files, and the
production rows show it producing 764/478-token researcher steps that are half
the length of Command A's. Cheapest-per-token is not cheapest-per-delivered-app
when the run has to be repeated.
