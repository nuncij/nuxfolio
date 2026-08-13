'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { MANUAL_PRICE_REF_PATTERN, type ValuedManualEntry } from '@/domain/manual';
import type { FxQuote } from '@/domain/portfolio';
import { canShowEur } from '@/lib/displayContext';

import {
  CurrencyToggle,
  readCurrency,
  readServerCurrency,
  subscribeToCurrency,
} from './CurrencyToggle';
import { DisplayProvider, useMoney } from './DisplayProvider';

/**
 * Balances the owner asserted by hand — the one page whose quantities Nuxfolio
 * cannot verify, and says so on every row.
 *
 * **Reads are open, writes are locked.** The form only works after the edit key
 * is entered once; it is kept in `localStorage` (a browser-local preference,
 * ADR-023's side of the line) and sent as a header on every write. A rejected
 * key re-locks the form rather than retrying — the server's 404 is deliberate
 * and the UI does not pretend to know more than "not accepted".
 *
 * **Visually distinct on purpose.** Dashed borders and a "reported by you"
 * marker on every row, because these numbers must never be mistaken for
 * chain-verified data (`docs/MANUAL_ENTRIES_PLAN.md` §4).
 */

const KEY_STORAGE = 'nuxfolio.manual.key';

/**
 * The edit key, read through `useSyncExternalStore` like the currency
 * preference: the server snapshot is always "locked", so markup cannot disagree
 * with the first client render, and same-tab writes notify the subscribers the
 * `storage` event does not cover.
 */
const keyListeners = new Set<() => void>();

function subscribeToKey(onChange: () => void): () => void {
  keyListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    keyListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readKey(): string | null {
  try {
    return window.localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function writeKey(value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(KEY_STORAGE);
    } else {
      window.localStorage.setItem(KEY_STORAGE, value);
    }
  } catch {
    // A sandboxed frame can refuse storage; editing simply stays locked.
  }
  for (const listener of keyListeners) {
    listener();
  }
}

type ManualPayload = {
  entries: readonly ValuedManualEntry[];
  totalValueUsd: string | null;
  fxRate: FxQuote | null;
};

type FormState = {
  id: number | null;
  label: string;
  symbol: string;
  quantity: string;
  priceRef: string;
};

const EMPTY_FORM: FormState = { id: null, label: '', symbol: '', quantity: '', priceRef: '' };

export function ManualView() {
  const [payload, setPayload] = useState<ManualPayload | 'failed' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currency = useSyncExternalStore(subscribeToCurrency, readCurrency, readServerCurrency);
  const editKey = useSyncExternalStore(subscribeToKey, readKey, () => null);

  // Bumped after every successful write; the effect below refetches on it.
  const [refreshToken, setRefreshToken] = useState(0);
  const load = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/manual')
      .then((response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        return response.json();
      })
      .then((body: ManualPayload) => {
        if (!cancelled) {
          setPayload(body);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (editKey === null) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch('/api/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-manual-key': editKey },
        body: JSON.stringify({
          id: form.id,
          label: form.label,
          symbol: form.symbol,
          quantity: form.quantity,
          priceRef: form.priceRef.trim() === '' ? null : form.priceRef.trim(),
        }),
      });
      if (response.status === 404) {
        relock();
        return;
      }
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        setNotice(body.error?.message ?? 'The entry was not saved.');
        return;
      }
      setForm(EMPTY_FORM);
      load();
    } catch {
      setNotice('The entry could not be saved this time.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (editKey === null) {
      return;
    }
    setNotice(null);
    try {
      const response = await fetch(`/api/manual?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-manual-key': editKey },
      });
      if (response.status === 404) {
        relock();
        return;
      }
      load();
    } catch {
      setNotice('The entry could not be deleted this time.');
    }
  }

  function relock() {
    writeKey(null);
    setNotice('The key was not accepted, so editing is locked again.');
  }

  function unlock(key: string) {
    const trimmed = key.trim();
    if (trimmed.length > 0) {
      writeKey(trimmed);
    }
  }

  const fxRate = payload !== null && payload !== 'failed' ? payload.fxRate : null;

  return (
    <DisplayProvider currency={canShowEur(fxRate) ? currency : 'USD'} fxRate={fxRate}>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink">Reported balances</h1>
            <p className="text-sm text-ink-muted">
              Quantities are yours, prices are the market&rsquo;s. Nuxfolio verified neither the
              balance nor where it is held.
            </p>
          </div>
          {canShowEur(fxRate) ? <CurrencyToggle /> : null}
        </header>

        {payload === null ? null : payload === 'failed' ? (
          <section className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm text-ink-muted">
              Reported balances could not be read this time. The entries themselves are safe; only
              this page&rsquo;s view of them failed.
            </p>
          </section>
        ) : (
          <Entries
            payload={payload}
            unlocked={editKey !== null}
            onEdit={(entry) =>
              setForm({
                id: entry.id,
                label: entry.label,
                symbol: entry.symbol,
                quantity: entry.quantity,
                priceRef: entry.priceRef ?? '',
              })
            }
            onDelete={remove}
          />
        )}

        {notice !== null ? (
          <p role="status" className="text-sm text-caution">
            {notice}
          </p>
        ) : null}

        {editKey === null ? (
          <Unlock onUnlock={unlock} />
        ) : (
          <EntryForm form={form} saving={saving} onChange={setForm} onSubmit={submit} />
        )}
      </div>
    </DisplayProvider>
  );
}

function Entries({
  payload,
  unlocked,
  onEdit,
  onDelete,
}: {
  payload: ManualPayload;
  unlocked: boolean;
  onEdit: (entry: ValuedManualEntry) => void;
  onDelete: (id: number) => void;
}) {
  const money = useMoney();

  if (payload.entries.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-line bg-surface p-4">
        <p className="text-sm text-ink-muted">
          Nothing reported yet. Entries you add here — exchange balances, cold storage — are priced
          at market and always marked as yours.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Reported balances"
      className="overflow-hidden rounded-xl border border-dashed border-line-strong"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">
            Balances reported by the owner, with market prices. Quantities are asserted, not
            verified.
          </caption>
          <thead>
            <tr className="border-b border-line bg-surface-raised text-left">
              <th scope="col" className="px-4 py-3 font-medium text-ink-muted">
                Entry
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Value
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Quantity
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Price
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {payload.entries.map((entry) => (
              <tr key={entry.id} className="border-b border-line/60 last:border-0">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{entry.symbol}</span>
                    <span className="text-ink-subtle">{entry.label}</span>
                    <span
                      title={`You entered this quantity yourself on ${entry.updatedAt.slice(0, 10)}. Nuxfolio cannot verify it.`}
                      className="rounded border border-caution-line px-1.5 py-0.5 text-[10px] tracking-wide text-caution uppercase"
                    >
                      reported by you · {entry.updatedAt.slice(0, 10)}
                    </span>
                  </div>
                </th>
                <td className="numeric px-4 py-3 text-right font-medium text-ink">
                  {entry.valueUsd === null ? (
                    <span className="font-normal text-ink-subtle">No price</span>
                  ) : (
                    money(entry.valueUsd)
                  )}
                </td>
                <td className="numeric px-4 py-3 text-right text-ink">{entry.quantity}</td>
                <td className="numeric px-4 py-3 text-right text-ink-muted">
                  {entry.priceUsd === null ? (
                    '—'
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {money(entry.priceUsd)}
                      <QualityFlag quality={entry.priceQuality} />
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {unlocked ? (
                    <span className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit(entry)}
                        className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:text-ink"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(entry.id)}
                        className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:text-ink"
                      >
                        Delete
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-surface-raised">
              <th scope="row" className="px-4 py-3 text-left font-medium text-ink">
                Reported total
              </th>
              <td className="numeric px-4 py-3 text-right font-semibold text-ink">
                {money(payload.totalValueUsd)}
              </td>
              <td colSpan={3} className="px-4 py-3 text-right text-xs text-ink-subtle">
                Never mixed into any chain-verified total
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/**
 * The same three flags every priced row in the product carries — dropped by the
 * first version of this page, which made a stale or single-source quote look
 * normal inside the reported total (round 16 follow-up).
 */
function QualityFlag({ quality }: { quality: ValuedManualEntry['priceQuality'] }) {
  if (quality === null || quality === 'ok') {
    return null;
  }
  const label =
    quality === 'stale'
      ? 'Price may be out of date'
      : quality === 'unknown-age'
        ? 'Price age could not be confirmed'
        : 'Low-confidence price';
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-block size-1.5 rounded-full bg-caution"
    />
  );
}

function Unlock({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [key, setKey] = useState('');

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onUnlock(key);
        setKey('');
      }}
    >
      <label className="flex-1 text-sm text-ink-muted">
        Edit key
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          className="mt-1 w-full rounded border border-line bg-surface-raised px-3 py-2 text-ink"
        />
      </label>
      <button
        type="submit"
        className="rounded border border-line px-4 py-2 text-sm text-ink hover:bg-surface-raised"
      >
        Unlock editing
      </button>
      <p className="w-full text-xs text-ink-subtle">
        The key is <code>NUXFOLIO_EDIT_KEY</code> on the server. Without it this page is read-only.
      </p>
    </form>
  );
}

function EntryForm({
  form,
  saving,
  onChange,
  onSubmit,
}: {
  form: FormState;
  saving: boolean;
  onChange: (next: FormState) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const refLooksWrong =
    form.priceRef.trim() !== '' && !MANUAL_PRICE_REF_PATTERN.test(form.priceRef.trim());

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-dashed border-line-strong bg-surface p-4"
    >
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {form.id === null ? 'Report a balance' : `Edit entry #${form.id}`}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink-muted">
          Where it is
          <input
            required
            value={form.label}
            onChange={(event) => onChange({ ...form, label: event.target.value })}
            placeholder="Binance"
            className="mt-1 w-full rounded border border-line bg-surface-raised px-3 py-2 text-ink"
          />
        </label>
        <label className="text-sm text-ink-muted">
          Symbol
          <input
            required
            value={form.symbol}
            onChange={(event) => onChange({ ...form, symbol: event.target.value })}
            placeholder="BTC"
            className="mt-1 w-full rounded border border-line bg-surface-raised px-3 py-2 text-ink"
          />
        </label>
        <label className="text-sm text-ink-muted">
          Quantity
          <input
            required
            inputMode="decimal"
            value={form.quantity}
            onChange={(event) => onChange({ ...form, quantity: event.target.value })}
            placeholder="0.5"
            className="numeric mt-1 w-full rounded border border-line bg-surface-raised px-3 py-2 text-ink"
          />
        </label>
        <label className="text-sm text-ink-muted">
          Price id (optional)
          <input
            value={form.priceRef}
            onChange={(event) => onChange({ ...form, priceRef: event.target.value })}
            placeholder="coingecko:bitcoin"
            className="numeric mt-1 w-full rounded border border-line bg-surface-raised px-3 py-2 text-ink"
          />
        </label>
      </div>
      {refLooksWrong ? (
        <p className="text-xs text-caution">
          A price id looks like <code>coingecko:bitcoin</code> — the CoinGecko id, lowercase.
          Without a valid one the entry is shown unpriced.
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving || refLooksWrong}
          className="rounded border border-line px-4 py-2 text-sm text-ink hover:bg-surface-raised disabled:opacity-50"
        >
          {form.id === null ? 'Add entry' : 'Save changes'}
        </button>
        {form.id !== null ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FORM)}
            className="rounded border border-line px-4 py-2 text-sm text-ink-muted hover:text-ink"
          >
            Cancel edit
          </button>
        ) : null}
      </div>
    </form>
  );
}
