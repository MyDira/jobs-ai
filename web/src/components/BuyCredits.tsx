"use client";

import { useState } from "react";

export function BuyCredits({ packs, configured }: { packs: number[]; configured: boolean }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(cents: number) {
    setBusy(cents);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cents }) });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not start checkout");
      window.location.assign(data.url as string);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="mb-2 text-xs text-muted">Add credits (one-time payment, no subscription)</p>
      <div className="flex flex-wrap gap-2">
        {packs.map((c) => (
          <button
            key={c}
            disabled={busy !== null || !configured}
            onClick={() => void buy(c)}
            className="rounded-md border border-line bg-panel px-4 py-2 text-sm font-medium hover:border-accent disabled:opacity-50"
          >
            {busy === c ? "Opening…" : `$${c / 100}`}
          </button>
        ))}
      </div>
      {!configured && <p className="mt-2 text-xs text-muted">Payments are not configured on this server yet.</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
