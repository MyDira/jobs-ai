import Stripe from "stripe";
import { env } from "@/lib/env";

let cached: Stripe | null = null;

export function stripeConfigured() {
  return Boolean(env.stripeSecretKey());
}

export function getStripe(): Stripe {
  if (!cached) cached = new Stripe(env.stripeSecretKey());
  return cached;
}
