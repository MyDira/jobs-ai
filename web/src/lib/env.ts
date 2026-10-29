function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => req("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => req("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  supabaseServiceRoleKey: () => req("SUPABASE_SERVICE_ROLE_KEY"),
  /** Optional fixed public origin. When unset, the origin is derived from the request (see lib/origin.ts). */
  siteUrlOverride: () => process.env.NEXT_PUBLIC_SITE_URL || process.env.URL || "",
  /**
   * When false (the default while testing), nobody is charged: no balance checks, no debits, checkout off.
   * Usage is still metered and recorded so you can see what it would have cost.
   */
  billingEnabled: () => (process.env.BILLING_ENABLED ?? "false").toLowerCase() === "true",
  /** Stop starting new model calls in one HTTP request after this long; the client then continues the turn. */
  requestBudgetMs: () => Number(process.env.AGENT_REQUEST_BUDGET_MS ?? 35_000),
  agentModel: () => process.env.AGENT_MODEL ?? "claude-opus-5-5",
  agentEffort: (): "low" | "medium" | "high" | "xhigh" | "max" => {
    const e = process.env.AGENT_EFFORT ?? "medium";
    return (["low", "medium", "high", "xhigh", "max"].includes(e) ? e : "medium") as
      | "low" | "medium" | "high" | "xhigh" | "max";
  },
  agentMaxCalls: () => Number(process.env.AGENT_MAX_CALLS ?? 8),
  creditMarkup: () => Number(process.env.CREDIT_MARKUP ?? 1.5),
  turnReserveMicros: () => Number(process.env.CREDIT_TURN_RESERVE_MICROS ?? 50_000),
  welcomeCreditMicros: () => Number(process.env.WELCOME_CREDIT_CENTS ?? 0) * 10_000,
  stripeSecretKey: () => process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET ?? "",
};
