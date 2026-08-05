# M3-1 — Saved wallets, local-first

Executable specification. Parent: `DEV_PLAN.md` Milestone 3, item M3-1.
**Status: delivered 2026-08-03.** Decision recorded as ADR-023.

Keyless, serverless, no new dependency, no server-side change of any kind.

Revised after independent review (`REVIEW_LOG.md` round 7, verdict REVISE, 7
blockers). Two of the first draft's own premises turned out to be false and are
corrected below rather than quietly dropped.

## Problem

Every visit starts from an empty box. Correct for a stranger trying the product
once; wrong for the owner, who checks the same two or three wallets repeatedly and
retypes or re-pastes an address each time.

## Scope: what this is and is not

**A list of saved addresses with optional labels, and one click to open each.**
That is the whole first release.

**No cached money figures.** The first draft put the last-seen total next to each
row, and review found that four of its seven blockers were about that one field: a
portfolio total is a _scoped priced subtotal_ (it can be one network or five, with
failed networks excluded and unpriced assets outside it), so a bare `$104,527` on
the landing page would present a possibly-single-chain, possibly-partial figure as
the wallet's worth. Stating it honestly needs a terminal-outcome model, recorded
scope, and stale-labelling rules — real work, and none of it is needed to stop
retyping addresses. Deferred to a follow-on item, designed properly, once this
exists.

**Called "Saved wallets", not "Watchlist".** A watchlist implies something is being
watched. Nothing here refreshes in the background, and the name should not promise
that.

Also deliberately absent: sync across devices (that is the account decision in
`DEV_PLAN.md` Part 4), background refresh, import/export, manual reordering.

## Design

### Where it lives

`localStorage`, in the browser. No accounts, no server state, nothing new to back
up, and nothing for a server to leak because the server never learns the list
exists.

The cost is stated rather than hidden: **the list does not follow you to another
device**, and the panel says so.

**ADR-002 needs amending, not citing.** The first draft claimed "ADR-002 holds". It
does not: ADR-002's own consequences say watchlists are the feature that introduces
Postgres. That was written before a local-first option was considered, and the
standing record now contradicts itself. This item ships with an ADR superseding
that clause and drawing the line explicitly — **browser-local preference data is
not server persistence**, and only the second needs a database. Leaving the
contradiction would mean a later reader cannot tell which document to trust.

### The stored shape

```ts
type SavedWallet = {
  /** Checksummed address. The canonical identity, as everywhere else. */
  address: string;
  /** User-supplied, optional. Trimmed, capped, bidi-stripped. */
  label: string | null;
  /**
   * The ENS name it was entered as, if any — a display hint, never an identity.
   * The address stays canonical: a name can stop resolving or come to point
   * somewhere else, and a saved wallet must not silently follow it.
   */
  ensName: string | null;
  /** When it was saved, ISO. The ordering key. */
  savedAt: string;
};

type SavedWalletsV1 = { version: 1; wallets: SavedWallet[] };
```

`version` is present from the first release, because stored data outlives code.
Known older versions migrate forward after validation; an **unknown newer** version
is preserved and reported as unsupported, never interpreted or overwritten.

**M3-2 does not constrain this shape.** The first draft claimed it had to
accommodate multi-wallet bundles. It does not: M3-2 is `/bundle/0xA,0xB,0xC` —
"pure computation, shareable as a URL, **no storage**". A bundle will _read_
canonical addresses from this list, which any shape supports. If persistent bundles
are ever wanted, they are a separate key holding references to addresses.

### Reading storage: five outcomes, not two

The existing `parseThemeMode` / `parseCurrency` pattern falls back to a default on
anything unrecognised. Right for a theme and **wrong here**: "you have no saved
wallets" is a _claim_, and making it when the store is corrupt or unreadable is
exactly the class of untrue statement this project refuses. Worse, a subsequent save
would then overwrite data the code did not understand.

So a read returns a discriminated result:

| Outcome               | Meaning                                      | What the UI does                                                   |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `ok`                  | parsed cleanly                               | render the list                                                    |
| `empty`               | key absent                                   | render the empty state — the only case that may say "none saved"   |
| `partially-invalid`   | some entries dropped                         | render the survivors **and say how many were ignored**             |
| `unsupported-version` | a version this build does not know           | say so; **refuse to write**, so newer data is not clobbered        |
| `unavailable`         | storage threw (disabled, private mode, full) | say saving is not possible here; the rest of the app is unaffected |

`partially-invalid` and `unsupported-version` are the two the first draft collapsed
into "empty".

### Validation on read

Every entry is parsed with a zod schema; anything failing is **dropped, not
repaired**, and its siblings still render.

- Address re-validated through `parseWalletAddress`. A stored string is not an
  address until checked.
- ENS name re-validated through `parseEnsName`.
- `savedAt` must parse as a date and must not be implausibly in the future.
- **Every string is bounded, and so is the raw payload** (32 kB). The first draft
  bounded only the label, which leaves a single huge `ensName` able to stall parsing
  and layout.
- Labels: trimmed, capped at 40 characters, control characters **and Unicode
  bidirectional overrides** stripped. React prevents script injection at the text
  sink; it does nothing about `U+202E`, which can make a label visually reverse the
  address beside it. The canonical address is always shown, never replaced by a
  label.
- Duplicate addresses deduplicated case-insensitively, earliest `savedAt` winning.
- List capped at 50. Reaching the cap **refuses the save visibly** rather than
  silently truncating.

### Writing

- Every write is a **read-modify-write that re-reads immediately before mutating**.
  `localStorage` has no transaction, and two tabs saving at once would otherwise
  clobber each other. Last writer wins, and that is stated rather than assumed.
- Every write is wrapped: a quota or security error surfaces as "could not save"
  rather than appearing to succeed.
- Nothing is auto-saved. A wallet joins the list because the user pressed save.

### Ordering

By `savedAt`, newest first, with the address as a tie-breaker so the order is total
and stable.

Deliberately **not** by value — and not only because no value is stored in this
release. Ordering by a figure the UI does not display would leak relative values and
reshuffle rows for invisible reasons, and a stable order is what the forthcoming
bundle picker needs.

No decimal comparison appears here. When totals arrive, ADR-003 applies: sorting
money uses `compareDecimal`, never a lexical or `Number` comparison.

### Cross-tab and hydration

- `useSyncExternalStore`, as `ThemeToggle` and `CurrencyToggle` do — but **not
  copied literally.** Those return a primitive, so re-reading storage on every
  snapshot is harmless. A list is an object, and returning a freshly parsed array
  each time makes every snapshot look changed, which React treats as an endless
  update. The snapshot is therefore **cached and keyed by the raw stored string**,
  reparsed only when that string changes, with a single frozen empty value as the
  server snapshot.
- The `storage` event fires in other tabs, giving cross-tab sync for free.
- Module-scope listener set, so several components and several tabs cannot disagree.

### Navigation: no request may leave the page

Rows link to `portfolioPath({ address })` — the canonical address, never the ENS
name, so listing a wallet cannot trigger server-side name resolution.

**`prefetch={false}` on every row, and this is the point of the acceptance test.**
Next.js prefetches `<Link>` targets as they enter the viewport in production, so a
default link would send every saved address to the app server before any click —
telling the server precisely the list this feature is designed never to disclose.
Review raised it as a hypothesis; it is treated as true because the cost of being
wrong is the feature's whole privacy claim.

### Privacy, which this feature changes

Today `localStorage` holds a theme and a currency. After this it holds **a list of
wallets someone watches**, which is materially different on a shared, borrowed or
recovered machine. The limits are worth stating plainly:

- Any script running on this origin can read it. Same trust boundary the app
  already has, but the consequence is now a wallet list rather than a colour.
- Clearing the list is a `localStorage` delete, **not secure erasure**. Browser
  profile backups and sync may retain it.
- `storage` events carry the full old and new value to other same-origin tabs.
- The panel states the list is stored in this browser only; removal is one click and
  clearing everything is one action.

### Surfaces

| Surface                               | Rule                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `lib/savedWallets.ts`                 | **new** — schema, five-outcome read, mutations. No React                    |
| `components/SavedWalletsPanel.tsx`    | **new** — the landing-page list                                             |
| `components/SaveWalletButton.tsx`     | **new** — save/remove in the portfolio header                               |
| `app/page.tsx`                        | renders the panel below the form                                            |
| `components/PortfolioView.tsx`        | hosts the save control; **writes nothing else**                             |
| `domain/*`, `server/*`, `providers/*` | **no change.** Browser-local feature; a portfolio's meaning does not change |

## Tests

| Area          | Cases                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read outcomes | each of the five produced by the input that should produce it; a corrupt store never reported as empty; an unsupported version refuses to write                                                                                                              |
| Validation    | malformed entry dropped while siblings survive; non-address dropped; label over the cap trimmed; control characters and `U+202E` stripped; oversized payload rejected; duplicates deduplicated with the earliest winning; list over 50 refuses visibly       |
| Mutations     | save idempotent on the same address; address case-insensitive (checksummed and lowercase are one wallet); remove leaves the rest; clear empties; label edit preserves `savedAt`; a write that throws surfaces rather than silently failing                   |
| Concurrency   | a mutation re-reads first, so a change made in another tab between read and write is not clobbered                                                                                                                                                           |
| Snapshot      | the client snapshot is referentially stable across reads when storage has not changed — the property that keeps `useSyncExternalStore` from looping                                                                                                          |
| Ordering      | newest first; ties broken by address; total and stable                                                                                                                                                                                                       |
| E2E           | save from the portfolio view → appears on the landing page → click opens that portfolio; remove is one click; survives a reload; syncs to a second tab; **loading the landing page with a populated list issues zero requests mentioning any saved address** |

## Acceptance

`pnpm verify` green; E2E covering save → land → open → remove, a reload, and a
second tab; the zero-request assertion above passing with prefetch disabled; a
corrupt store proven to say so rather than claim the list is empty; and an ADR that
resolves ADR-002's watchlist clause rather than leaving the record contradicting
itself.

---

## Delivered

| Criterion                      | Result                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| `pnpm verify` green            | 728 unit tests across 34 files; lint, types, production build clean        |
| E2E green                      | 20 scenarios, five new                                                     |
| Zero-request assertion         | Passing: no request mentioning a saved address when the landing page loads |
| Corrupt store says so          | Asserted in E2E — "could not be read", never "no saved wallets"            |
| Snapshot referentially stable  | Asserted directly, including across twenty consecutive reads               |
| ADR-002 contradiction resolved | ADR-023, with the superseded clause marked in place                        |

Two defects were found while building, both by tests rather than by review:

- **`saveWallet` did not validate its address.** `WalletAddress` is `0x${string}`,
  which cannot carry a checksum guarantee, so an entry written with a bad checksum
  was dropped by the very next read — the save appeared to work and then lost the
  wallet. Found because a test fixture had a hand-written checksum. It now validates
  and canonicalises, with a test asserting that anything written reads back.
- **Removing the last wallet left the panel on screen.** An emptied store reads back
  as `ok` with zero wallets, not `empty` — which means "key absent". The panel now
  hides on "no wallets and nothing to explain", which covers both.

**The zero-request test caught something, then caught the diagnosis too.** It failed
in CI with two `?_rsc=` prefetches of the saved address. The first conclusion —
"`prefetch={false}` does not cover hover" — was wrong: the requests came from the
landing page's own hard-coded "try a public example wallet" link, which points at the
very address the test had saved, so a leak and a link that had always been there were
indistinguishable. The test now seeds a **different** address, and hovers the row
deliberately so it exercises the trigger rather than relying on timing. Rows are plain
anchors regardless — a guarantee with no prefetch behaviour to disable beats a flag
whose meaning has to be re-checked.

One thing worth recording about the bidi defence: the first implementation put the
characters into the source as literals. The shell then **refused the command that
would have fixed them**, because it "contains control characters that would be hidden
in the approval dialog" — a tool independently making the same argument the code
makes. Both files now express them as escapes and contain zero literal invisible
characters, asserted by a check over the file bytes.
