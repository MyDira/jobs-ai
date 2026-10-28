import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { PACKS } from "@/lib/credits";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { cents } → { url } for a Stripe Checkout session that buys a credit pack. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!stripeConfigured()) return NextResponse.json({ error: "Payments are not configured yet (STRIPE_SECRET_KEY)." }, { status: 503 });

  const { cents } = (await req.json().catch(() => ({}))) as { cents?: number };
  if (!cents || !(PACKS as readonly number[]).includes(cents)) {
    return NextResponse.json({ error: "Choose a valid pack" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: purchase, error } = await svc
    .from("credit_purchases")
    .insert({ user_id: user.id, amount_cents: cents, credits_micros: cents * 10_000, status: "pending" })
    .select("id")
    .single();
  if (error || !purchase) return NextResponse.json({ error: error?.message ?? "Could not start purchase" }, { status: 500 });

  const site = env.siteUrl();
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: { name: `Jobs AI credits: $${(cents / 100).toFixed(2)}` },
        },
      },
    ],
    metadata: { user_id: user.id, purchase_id: String(purchase.id), cents: String(cents) },
    success_url: `${site}/app/credits?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/app/credits?status=cancelled`,
  });

  await svc.from("credit_purchases").update({ stripe_checkout_session_id: session.id }).eq("id", purchase.id);
  return NextResponse.json({ url: session.url });
}
