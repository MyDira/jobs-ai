import { createServiceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

/** Anthropic list prices in USD per million tokens. Cache write = 5-minute TTL. */
export const PRICE_TABLE: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number }> = {
  "claude-opus-5-5": { input: 4.0, cacheWrite: 5.0, cacheRead: 0.2, output: 20.0 },
  "claude-opus-5": { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  "claude-sonnet-5-5": { input: 2.0, cacheWrite: 2.5, cacheRead: 0.2, output: 10.0 },
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
};

export type Usage = {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
};

export const MICROS_PER_DOLLAR = 1_000_000;

/** Cost in micro-dollars after markup. Unknown models are priced at the Opus 5.5 rate. */
export function priceUsage(model: string, u: Usage, markup = env.creditMarkup()): number {
  const p = PRICE_TABLE[model] ?? PRICE_TABLE["claude-opus-5-5"];
  const usd =
    (u.input_tokens * p.input +
      u.cache_read_tokens * p.cacheRead +
      u.cache_write_tokens * p.cacheWrite +
      u.output_tokens * p.output) /
    1_000_000;
  return Math.ceil(usd * markup * MICROS_PER_DOLLAR);
}

export function effectiveRates(model: string, markup = env.creditMarkup()) {
  const p = PRICE_TABLE[model] ?? PRICE_TABLE["claude-opus-5-5"];
  return {
    input: p.input * markup,
    cacheWrite: p.cacheWrite * markup,
    cacheRead: p.cacheRead * markup,
    output: p.output * markup,
  };
}

export function formatMicros(micros: number, decimals = 2): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / MICROS_PER_DOLLAR).toFixed(decimals)}`;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export const ZERO_USAGE: Usage = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 };

/** Creates the account on first use (with the optional welcome credit) and returns the balance. */
export async function ensureAccount(userId: string): Promise<number> {
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("ensure_credit_account", {
    p_user: userId,
    p_welcome_micros: env.welcomeCreditMicros(),
  });
  if (error) throw new Error(`ensure_credit_account: ${error.message}`);
  return Number(data);
}

export async function getBalance(userId: string): Promise<number> {
  return ensureAccount(userId);
}

export async function debit(
  userId: string,
  amountMicros: number,
  meta: {
    conversation_id?: string;
    message_id?: string;
    model?: string;
    calls?: number;
    note?: string;
  } & Partial<Usage>,
): Promise<number> {
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("debit_credits", {
    p_user: userId,
    p_amount_micros: amountMicros,
    p_meta: meta,
  });
  if (error) throw new Error(`debit_credits: ${error.message}`);
  return Number(data);
}

export async function grant(
  userId: string,
  amountMicros: number,
  kind: "purchase" | "adjustment" | "refund" | "welcome",
  ref?: string,
  note?: string,
): Promise<number> {
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("grant_credits", {
    p_user: userId,
    p_amount_micros: amountMicros,
    p_kind: kind,
    p_ref: ref ?? null,
    p_note: note ?? null,
  });
  if (error) throw new Error(`grant_credits: ${error.message}`);
  return Number(data);
}

/** Credit packs offered at checkout, in cents. The smallest is $5. */
export const PACKS = [500, 1000, 2000, 5000] as const;
