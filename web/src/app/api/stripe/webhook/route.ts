import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/service";
import { grant } from "@/lib/credits";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe → us. Verifies the signature, then credits the account once per checkout session.
 * Idempotent: a session already marked paid is ignored.
 */
export async function POST(req: Request) {
  if (!stripeConfigured() || !env.stripeWebhookSecret()) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, env.stripeWebhookSecret());
  } catch (e) {
    return NextResponse.json({ error: `Bad signature: ${(e as Error).message}` }, { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") return NextResponse.json({ received: true });
    await fulfil(session);
  } else if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const svc = createServiceClient();
    await svc.from("credit_purchases").update({ status: "failed" }).eq("stripe_checkout_session_id", session.id).eq("status", "pending");
  }
  return NextResponse.json({ received: true });
}

async function fulfil(session: Stripe.Checkout.Session) {
  const svc = createServiceClient();
  const userId = session.metadata?.user_id;
  const cents = Number(session.metadata?.cents ?? session.amount_total ?? 0);
  if (!userId || !cents) return;

  // Claim the purchase row atomically; if it is already paid this is a replay.
  const { data: claimed } = await svc
    .from("credit_purchases")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_checkout_session_id: session.id,
    })
    .eq("stripe_checkout_session_id", session.id)
    .eq("status", "pending")
    .select("id, credits_micros");
  let creditsMicros = claimed?.[0]?.credits_micros as number | undefined;
  if (!claimed || claimed.length === 0) {
    // Row never got the session id (checkout created but our update failed) or already paid.
    const { data: existing } = await svc.from("credit_purchases").select("id, status").eq("stripe_checkout_session_id", session.id).maybeSingle();
    if (existing) return; // already handled
    const { data: inserted } = await svc
      .from("credit_purchases")
      .insert({ user_id: userId, amount_cents: cents, credits_micros: cents * 10_000, status: "paid", paid_at: new Date().toISOString(), stripe_checkout_session_id: session.id })
      .select("credits_micros")
      .single();
    creditsMicros = inserted?.credits_micros;
  }
  if (!creditsMicros) return;
  await grant(userId, creditsMicros, "purchase", session.id, `Credit pack $${(cents / 100).toFixed(2)}`);
}
