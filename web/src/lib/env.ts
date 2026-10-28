function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => req("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => req("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  supabaseServiceRoleKey: () => req("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: () => process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
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
