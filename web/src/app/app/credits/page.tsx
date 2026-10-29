import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveRates, formatMicros, getBalance, PACKS } from "@/lib/credits";
import { env } from "@/lib/env";
import { stripeConfigured } from "@/lib/stripe";
import { BuyCredits } from "@/components/BuyCredits";

export const dynamic = "force-dynamic";

type LedgerRow = {
  id: number;
  kind: string;
  amount_micros: number;
  balance_after_micros: number;
  model: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  calls: number;
  ref: string | null;
  note: string | null;
  created_at: string;
};

export default async function CreditsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [balance, { data: ledger }] = await Promise.all([
    getBalance(user.id),
    supabase.from("credit_ledger").select("*").order("created_at", { ascending: false }).limit(200),
  ]);
  const rows = (ledger as LedgerRow[]) ?? [];
  const model = env.agentModel();
  const rates = effectiveRates(model);
  const markup = env.creditMarkup();
  const billing = env.billingEnabled();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{billing ? "Credits" : "Usage"}</h1>
      {!billing && (
        <p className="mt-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          Free testing: usage is unlimited and nobody is charged. Every reply is still metered, so the history below shows the tokens used and what each turn would have cost at the rates listed.
        </p>
      )}
      {sp.status === "success" && (
        <p className="mt-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">Payment received. Credits appear as soon as Stripe confirms it, usually within a few seconds. Refresh if the balance has not updated.</p>
      )}
      {sp.status === "cancelled" && <p className="mt-3 rounded-md border border-line bg-soft px-3 py-2 text-sm">Checkout cancelled. Nothing was charged.</p>}

      {billing && (
        <section className="mt-6 flex flex-wrap items-end justify-between gap-4 rounded-lg border border-line bg-panel p-5">
          <div>
            <p className="text-sm text-muted">Balance</p>
            <p className="text-3xl font-semibold">{formatMicros(balance)}</p>
          </div>
          <BuyCredits packs={[...PACKS]} configured={stripeConfigured()} />
        </section>
      )}

      <section className="mt-6 rounded-lg border border-line bg-panel p-5 text-sm">
        <h2 className="font-medium">{billing ? "How you are charged" : "How you will be charged once billing is on"}</h2>
        <p className="mt-1 text-muted">
          Each reply is metered by the tokens the model reads and writes. The rates below are what you pay per million tokens on {model}
          ({markup}× Anthropic&apos;s list price, which covers card fees and running the service). Cached input is the part of the conversation the model already saw and re-reads at a discount.
        </p>
        <table className="mt-3 w-full text-left">
          <tbody>
            <tr className="border-t border-line"><td className="py-1.5 text-muted">Input</td><td className="text-right">${rates.input.toFixed(2)} / M tokens</td></tr>
            <tr className="border-t border-line"><td className="py-1.5 text-muted">Cached input (read)</td><td className="text-right">${rates.cacheRead.toFixed(2)} / M tokens</td></tr>
            <tr className="border-t border-line"><td className="py-1.5 text-muted">Cached input (write)</td><td className="text-right">${rates.cacheWrite.toFixed(2)} / M tokens</td></tr>
            <tr className="border-t border-line"><td className="py-1.5 text-muted">Output (including the model&apos;s thinking)</td><td className="text-right">${rates.output.toFixed(2)} / M tokens</td></tr>
          </tbody>
        </table>
        <p className="mt-2 text-muted">A typical search turn costs a few cents to about fifteen cents. A new message is refused when the balance is under {formatMicros(env.turnReserveMicros())}; a turn that runs the balance past zero is allowed to finish, and the small overdraft is settled from your next pack.</p>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-medium">History</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No activity yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr><th className="py-1 pr-3">When</th><th className="py-1 pr-3">What</th><th className="py-1 pr-3 text-right">Tokens in / cached / out</th><th className="py-1 pr-3 text-right">Amount</th><th className="py-1 text-right">Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 text-muted">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="py-1.5 pr-3">
                      <span className="capitalize">{r.kind}</span>
                      {r.note && <span className="text-muted"> · {r.note}</span>}
                      {r.model && <span className="block text-xs text-muted">{r.model}{r.calls ? ` · ${r.calls} call${r.calls === 1 ? "" : "s"}` : ""}</span>}
                      {r.ref && <span className="block font-mono text-xs text-muted">{r.ref}</span>}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-xs">
                      {r.kind === "usage" ? `${r.input_tokens.toLocaleString()} / ${(r.cache_read_tokens + r.cache_write_tokens).toLocaleString()} / ${r.output_tokens.toLocaleString()}` : ""}
                    </td>
                    <td className={`whitespace-nowrap py-1.5 pr-3 text-right font-mono ${r.amount_micros < 0 ? "" : "text-accent"}`}>{formatMicros(r.amount_micros, 4)}</td>
                    <td className="whitespace-nowrap py-1.5 text-right font-mono">{formatMicros(r.balance_after_micros, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
