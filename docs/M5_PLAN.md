# M5 — Protocol accounting: what the wallet is _doing_, not just holding

Draft for review, 2026-08-06. Written before any code, per the process that caught a
blocker at plan stage in rounds 6, 7 and 8 — and twice caught a plan claim that was
factually wrong about this codebase.

---

## 1. The gap this closes

Nuxfolio reads what a wallet **holds**. It cannot see what a wallet is **doing**.

A wallet that supplied 100,000 USDC to Aave and borrowed 40,000 USDC against it shows
today as: some receipt tokens, if they happen to be on the bundled list, and nothing
else. No debt. No health factor. The headline total may be roughly right by accident,
or badly wrong, and the product cannot tell which.

That is the last item in the original brief still unmet — "which DeFi protocols and
positions the wallet is using" — and the gap between a token viewer and the DeBank
alternative this was meant to be.

Two lessons from milestone 1 are already recorded and both apply here:

> **"DeFi positions" is two different problems.** Receipt tokens (wstETH, syrupUSDC,
> stkAAVE…) are plain ERC-20s — already covered. What is genuinely missing is
> _protocol accounting_: debt, health factors, LP composition, unclaimed rewards.

So this milestone is **not** about finding more tokens. It is about reading state that
is not a token balance at all.

## 2. Measured before designing

Two things checked against the real repository rather than assumed, because the plan's
correctness depends on both:

**The double-count trap — measured wrongly the first time, corrected 2026-08-07.**

The original measurement matched token **symbols** against Aave's naming convention
(`aEthUSDC`, `aBasUSDC`) and reported **0** v3 receipts in the bundled lists. That was
false. The lists use their own symbol convention — the v3 aToken
`0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8` appears as symbol `AWETH`, name
`Aave v3 WETH` — so the search tested a guess about naming rather than the thing
itself. Re-measured by name across all 12,367 tokens:

| What                                          | In the bundled lists? |
| --------------------------------------------- | --------------------- |
| Tokens named `Aave v3 …`                      | **53**                |
| All Aave-named receipts (v2 and v3)           | **153**               |
| Aave debt tokens (`variableDebt…`)            | 0 — non-transferable  |
| Liquid-staking receipts (`wstETH`, `rETH`, …) | present, correctly    |

**How it was caught:** by looking at a screenshot of the finished feature. A real
borrower's largest asset read `AWETH $17,365.43` while the panel beneath it reported
`collateral $17,376.14` — the same position, twice, about $11 apart because two price
sources valued it. No test would have found this; the numbers are individually correct.

**What it changes.** Debt is still new information everywhere — debt tokens are
non-transferable and appear in no list. Collateral is _sometimes_ already in the asset
total and sometimes not, with nothing in the data to say which. That makes the decision
in §4 stronger rather than weaker, and it makes the panel's wording load-bearing: it
now says collateral **may also appear above as a receipt token**, because the earlier
"not included in the total above" invited exactly the addition it was trying to
prevent.

**Debt is new information everywhere.** Debt tokens are non-transferable and appear in
no list, so nothing in the product currently accounts for them at all.

**But the measurement only covers the keyless path** (round 12, F-07). With
`ALCHEMY_API_KEY` set, balances come from an indexer that enumerates _any_ ERC-20 the
wallet holds — including v3 aTokens that no bundled list contains. So under Alchemy,
collateral could appear both in `totalValueUsd` and in the Aave panel. v1 survives this
because it presents Aave's figures as **separate, explicitly non-additive facts** and
never sums them into a wallet total; the reconciliation only becomes necessary in M5-2,
when the two are combined. Both provider modes get a test.

## 3. The shape: a position is not an asset

`PortfolioAsset` is the wrong container. An asset has a quantity, a price and a value.
A protocol position has a **side** (collateral, borrowed), a **protocol and market
identity**, and sometimes a **health factor**, which is not money and has no price.

v1 reports one account per market — no per-token array at all:

```ts
type ProtocolAccount = {
  chainId: number;
  protocol: 'aave-v3';
  /**
   * Ethereum alone runs Core, Prime and EtherFi markets, each with its own pool,
   * its own reserves and its own health factor (round 12, F-04). Keying on
   * chain + protocol would read one and silently miss the rest.
   */
  marketId: string;
  marketName: string;
  /**
   * `ok` — read succeeded, the figures below are real, and zero means zero.
   * `failed` — the call did not answer; the figures are null and say nothing.
   * These are different states and must not collapse (round 12, F-05).
   */
  status: 'ok' | 'failed';
  /**
   * **Collateral, not supplied.** `getUserAccountData` returns only reserves the
   * user has enabled as collateral, so a supply-with-collateral-off position is
   * invisible here (round 12, F-03). Naming it `supplied` would be a false claim.
   * Denominated in Aave's own base currency — see §5a.
   */
  collateralValueUsd: string | null;
  borrowedValueUsd: string | null;
  /**
   * Aave's own figure, **18 decimals** — measured, and the plan first got this
   * wrong: it said ray (1e27), which would render a real 1.04 as 0.00000000104
   * (round 12, F-01). Null when there is no debt, where Aave returns uint256 max.
   */
  healthFactor: string | null;
};
```

Per-token detail (`ProtocolPosition[]`) is **M5-2**, not a deferred-but-present empty
array: an empty array asserts "checked, found none", which is exactly the substitution
this codebase exists to refuse. The field is absent in v1 because nothing looked.

## 4. The headline: no net total in v1

The first draft of this plan recommended `netValueUsd = totalValueUsd −
borrowedValueUsd`. **That formula is wrong**, and the review caught it before any code
existed (round 12, F-02).

The reason is not the one first given here. That said collateral is _invisible_ to
`totalValueUsd`; §2 now shows it is often visible. The real problem is that it is
**inconsistently** visible — 53 v3 receipts are listed and many are not, and nothing
distinguishes the two cases at runtime. So the formula is correct for a wallet whose
receipt token happens to be on a list, and wrong by the entire collateral for one
whose is not. Take the invisible case — supplies $100,000, borrows $40,000, keeps the
borrowed funds:

| Figure                            | Value       |
| --------------------------------- | ----------- |
| `totalValueUsd` (what v1 can see) | $40,000     |
| `netValueUsd` by the old formula  | **$0**      |
| What the wallet is actually worth | **$60,000** |

And if the borrowed funds had left the wallet, it would report **−$40,000**. In the
_visible_ case the same formula returns the right answer. A figure that is correct for
some wallets and silently wrong for others — with no way to tell them apart — is worse
than no figure at all.

**Decision: option (d) — v1 ships no net total at all.** `totalValueUsd` keeps its
meaning untouched, and Aave's figures appear as separately sourced facts in their own
panel: collateral, debt, health factor, each labelled as reported by Aave. One correct
headline would be better than none — but v1 cannot compute one, and a wrong headline is
worse than an absent one. A net total becomes possible in M5-2, when per-token
collateral is read and can be priced by the same source as everything else.

What a leveraged wallet should see first is therefore its **health factor and its
debt**, not an arithmetic combination of numbers from two different scopes.

## 5. Scope

**Aave v3 only, and per market rather than per chain.** Ethereum alone runs Core, Prime
and EtherFi markets, each a separate pool with its own reserves and its own health
factor. A bounded, configured list of markets per chain, sourced from Aave's address
book with the date it was checked — proxy addresses are stable, so a weekly refresh
like the token lists would be complexity that does not pay rent. CI sanity-checks that
each configured pool still answers.

**What v1 actually reports is borrower risk, not "your Aave positions".**
`getUserAccountData` returns `totalCollateralBase` — only reserves the user enabled as
collateral. A supply-only position with collateral toggled off is **invisible** to it
(round 12, F-03). Calling that field "supplied" would be a false claim, so it is
`collateralValueUsd`, and the milestone's promise is narrowed to match: debt, health
factor, and the collateral backing them.
Aave v2 is explicitly out: §2 measured 34 v2-era receipt tokens already in the lists,
so reading v2 positions would double-count without a suppression mechanism that is not
worth building for a deprecated protocol.

One protocol is the right size because it exercises the entire shape — supplied, debt,
and a health factor — so the second adapter is a repeat rather than a redesign. Lido
and Curve are named in `DEV_PLAN.md` for later; nothing here should make them harder.

**Reads — probed live on 2026-08-06** against `ethereum-rpc.publicnode.com`, the
endpoint the app already uses, because §7.1 said this must not stay an assumption:

| Call                                        | Cost            | Returns                                                               |
| ------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `Pool.getUserAccountData(user)`             | 1 call, ~110 ms | Totals (collateral, debt) **and health factor**. No per-token detail. |
| `UiPoolDataProvider.getUserReservesData(…)` | 1 call, ~60 ms  | All 67 reserves with per-token supplied and debt.                     |

Three corrections to what this plan said before the probe:

1. **The ABI in my head was wrong.** The 3.0 `UserReserveData` struct — with
   `stableBorrowRate`, `principalStableDebt` and a timestamp — fails to decode against
   the deployed contract. Aave 3.2 removed stable-rate borrowing, and the struct is now
   four fields: `underlyingAsset`, `scaledATokenBalance`,
   `usageAsCollateralEnabledOnUser`, `scaledVariableDebt`. Verified by getting it
   wrong first.
2. **Per-token balances are _scaled_, not real.** `scaledATokenBalance` must be
   multiplied by the reserve's liquidity index to become an amount, and that index is
   **not in this call**. So per-token detail is one call for the shape plus a second
   for the indices — the "whole position in one call" claim was false.
3. **`getUserReservesData` returns all 67 reserves regardless of position**, so the
   response is a fixed cost, not proportional to what the wallet holds.

**This changes the recommended scope.** Since `getUserAccountData` alone gives debt and
the health factor in **one call with no scaling arithmetic**, the honest v1 is that
call only:

- Totals and health factor: 1 call per chain, no index maths, no scaled-balance bug
  waiting to happen, and no double-count question at all — because nothing is added to
  the asset list.
- Per-token protocol detail becomes M5-2, once the shape is proven, and pays for its
  own extra call and its own arithmetic then.

The `ProtocolPosition` array in §3 is therefore **deferred with the design kept**: v1
ships `ProtocolAccount` with totals and health factor and an empty `positions` array.
That is a smaller change, and it means the risky arithmetic arrives separately from the
plumbing rather than tangled with it.

**Cost.** One or two `eth_call`s per chain per load, alongside the existing Multicall3
sweep, inside the same `Deadline`. A protocol read that overruns must degrade to a
warning, exactly as a failed price batch does — never to a missing total presented as
complete.

## 5a. Whose prices? (probed, and it changes the argument)

`getUserAccountData` returns money in Aave's **own base currency** — measured
2026-08-06: `BASE_CURRENCY` is the zero address (USD) with `BASE_CURRENCY_UNIT` of
1e8, so 8 decimals, priced by Aave's own oracle. That is a **second price source**
disagreeing with the app's:

| WETH, same moment  | Price    |
| ------------------ | -------- |
| Aave oracle        | $1912.61 |
| DefiLlama (in use) | $1912.02 |

0.03 % apart — comfortably inside ADR-019's 2 % disagreement threshold, so this is not
an accuracy problem. But it forces a choice, and the cheap option turns out to be the
coherent one:

**Take Aave's figures and say they are Aave's.** The health factor is computed by Aave
_from those same prices_. Re-pricing the debt with DefiLlama while showing Aave's
health factor would produce a page where the two numbers cannot be reconciled with each
other — a $40,000 debt beside a health factor derived from a slightly different $40,000.
Internal inconsistency is worse than a 0.03 % difference from another source, and it is
the kind of inconsistency a user would eventually notice and be unable to explain.

**One market at one moment is not a bound** (round 12, F-08). Aave's oracle interface
permits a non-USD base — ETH at 1e18, for instance — which would make both the `…Usd`
field names and the 8-decimal scaling false for that market. So each configured market
is probed for `BASE_CURRENCY`, `BASE_CURRENCY_UNIT`, pool code and latency **before it
is enabled**, and a market that does not report USD is left out rather than guessed at.

So `borrowedValueUsd` and `collateralValueUsd` are labelled as **reported by Aave**, in
the same spirit as ADR-019's rule that neither source wins and both are named. This
also removes the need to price anything in v1: no `PriceRef`, no second pricing path,
no partial-price case for a protocol position.

## 6. Honesty rules this inherits

- **A health factor is stated with its definition, but not interpreted.** "1.04" alone
  is not honest — a reader cannot tell whether it is a percentage or whether higher is
  better (round 12, F-09). A definition is not advice: "Aave health factor 1.04 — below
  1 becomes eligible for liquidation; higher is further from that threshold" states what
  the number _is_. "You should repay" states what to _do_, and remains out of scope.
- **No debt renders as "not applicable", not as a number.** Aave returns uint256 max,
  and any arithmetic on it produces nonsense.
- **No debt is not zero debt.** A wallet with no Aave position and a wallet whose Aave
  read failed are different states and must render differently.
- **Coverage must name what was checked.** Reading Aave and not Compound means a wallet
  can have positions Nuxfolio cannot see. The response says which protocols were
  checked, in the same spirit as `coverage: "token-list"`.
- **Health factor uses `Decimal`, not `number`**, at 18 decimals (§3).
- **Debt never aggregates through `sumPortfolioTotals` as-is.** That reducer drops null
  subtotals before summing, which both aggregation axes rely on (round 12, F-06). A
  failed Aave read would therefore shrink a "complete-looking" debt figure. Debt is
  summed only alongside `checked / failed / total` market counts and labelled "so far"
  until every in-scope read has settled — and health factors are **not additive** at
  all: they stay per market, with at most a _lowest observed_ figure carrying the same
  partial-coverage label.

## 7. What is still uncertain

After the probe and review round 12, honestly:

1. **Is a borrower-risk slice enough to be worth shipping?** v1 shows debt, collateral
   backing it, and a health factor — not "your Aave positions". A supplier with
   collateral off sees nothing. That is a real narrowing, and the answer is that debt
   and liquidation distance are the parts a wallet cannot currently learn anywhere in
   this product, while supplied balances are partly visible already through receipt
   tokens.
2. **Which markets, exactly?** Core, Prime and EtherFi on Ethereum, plus one market on
   each of the other four chains, is the assumption. Not yet probed per chain.
3. **How does the panel render three markets on one chain** without becoming a wall?
   Most wallets have zero or one. The empty case must cost nothing on screen.
4. **Does the progressive aggregate (ADR-015) need a fourth state?** Chains arrive one
   at a time; a debt figure that grows as networks report is honest only if labelled,
   and that label has no precedent in the existing summary.

## 8. Exit criteria

- A real wallet with an Aave v3 borrow shows debt, collateral and a health factor,
  reconciled **to the cent against Aave's own UI** — which is possible precisely
  because v1 reports Aave's figures rather than re-pricing them (§5a).
- The health factor renders `1.04`, not `0.00000000104` — a raw-value fixture pins the
  18-decimal decode, since this is the error the review caught.
- A wallet with no Aave position shows the panel **absent**, not a row of zeros; a
  wallet whose Aave read _failed_ shows a named warning. The two are visibly different.
- `totalValueUsd` is byte-identical to today for every existing test — asserted, so this
  milestone cannot quietly move a number that has meant one thing for five milestones.
- No net total appears anywhere in v1.

---

## 9. M5-2 as built — where it departed from this plan

Three of this plan's positions did not survive contact with the chain.

**§5a said pricing would not be needed at all.** "This also removes the need to price
anything in v1: no `PriceRef`, no second pricing path." Half right. M5-2 does put a
dollar figure on every row, but not through the app's price provider — through the
market's own `AaveOracle`, in the same batch as the balances. So there is still no
`PriceRef` and no second pricing path; what there is, unexpectedly, is a breakdown that
sums to its headline **to the base unit**, measured at four consecutive blocks. That
turned out to be worth more than source-consistency with the rest of the page. ADR-027
records why, including the rounding it forced: a debt ceils when it is scaled _and_
again when it is valued, which flooring the second step gets wrong by exactly one base
unit per borrowed row.

**§7.1 said a supplier with collateral off "sees nothing".** True at the account level
and now fixed, though not deliberately. The breakdown was at first read only for markets
whose totals were non-zero, to save a call — which left that supplier invisible, since a
collateral-off supply contributes to neither total. Review round 13 pushed back and the
call was measured at **134 ms across all three Ethereum markets**. It is now always read,
`hasPosition` consults the breakdown, and that wallet appears. The panel heading changed
from "Borrowing" to "Lending markets" for the same reason: it can now show a wallet whose
two headline figures are both zero.

**§7.3 asked how three markets on one chain render without becoming a wall.** They do not
have to: Prime and EtherFi report a confirmed-empty breakdown for the benchmark borrower,
and a market with nothing in it is still absent from the panel entirely. Only markets the
wallet actually uses cost any vertical space, and each brings at most a handful of rows.

**Still true, and still deliberate.** No net total (ADR-026 and ADR-027 both). Two of the
seven markets — Optimism and BNB — report totals and a health factor but no breakdown,
and say so in words rather than showing an empty list.

**§6's coverage rule is not met, and that is a defect rather than a scope choice.** The
rule reads: "Reading Aave and not Compound means a wallet can have positions Nuxfolio
cannot see. The response says which protocols were checked, in the same spirit as
`coverage: 'token-list'`." Nothing on the page says it. Naming Aave as the _source_ of
these figures is a different claim from telling a reader that Compound, Morpho and Spark
were never looked at — the first is attribution, the second is coverage, and only the
second stops the panel reading as complete. Tracked as M5-3, and it is next.

**Unclaimed rewards were in scope and are absent.** §5's table put rewards in the Aave
adapter's "full shape". No `RewardsController` read exists. Tracked as M5-4.
