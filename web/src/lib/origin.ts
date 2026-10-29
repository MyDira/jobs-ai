import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * Public origin for links we send out (email confirmations, Stripe return URLs).
 * Order: NEXT_PUBLIC_SITE_URL, Netlify's URL, then the incoming request's host, so deploy previews work.
 */
export async function getOrigin(): Promise<string> {
  const fixed = env.siteUrlOverride();
  if (fixed) return fixed.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
