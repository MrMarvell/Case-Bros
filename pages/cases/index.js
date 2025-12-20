import Link from 'next/link';
import { useEffect, useState } from 'react';
import Layout from '../../components/Layout';

export default function CasesIndex() {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/cases');
      const data = await res.json();
      setCases(Array.isArray(data?.cases) ? data.cases : []);
    } catch (e) {
      setErr(e?.message || 'Failed to load cases');
      setCases([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <Layout title="Cases">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Cases</h1>
          <button
            onClick={load}
            className="rounded-md bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700"
          >
            Refresh
          </button>
        </div>

        <p className="mt-2 text-sm text-neutral-400">
          Case icons/prices are fetched live when available. If the market/dataset is unreachable, placeholder images are shown.
        </p>

        {err ? (
          <div className="mt-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-red-200">
            {err}
          </div>
        ) : null}

        {loading ? (
          <div className="mt-8 text-neutral-400">Loading cases…</div>
        ) : null}

        {!loading && cases.length === 0 ? (
          <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-neutral-300">
            No cases found. If this is your first deploy, open Render logs and look for “Seeding…” messages.
          </div>
        ) : null}

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cases.map((c) => (
            <Link
              key={c.id}
              href={`/cases/${c.slug}`}
              className="group rounded-xl border border-neutral-800 bg-neutral-900 p-4 hover:border-neutral-700"
            >
              <div className="flex gap-3">
                <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-neutral-950">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.image_url || '/images/placeholder-case.png'}
                    alt={c.name}
                    className="h-full w-full object-contain"
                    loading="lazy"
                    onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/images/placeholder-case.png'; }}
                  />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{c.name}</div>
                  <div className="mt-1 text-sm text-neutral-400">
                    Case {c.case_price_usd ? `$${c.case_price_usd}` : '—'} · Key{' '}
                    {c.key_price_usd ? `$${c.key_price_usd}` : '—'}
                  </div>
                  <div className="mt-2 text-xs text-neutral-500 group-hover:text-neutral-400">Open →</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </Layout>
  );
}
