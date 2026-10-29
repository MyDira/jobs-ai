/**
 * Smoke test for the agent's read-only tools against the live database.
 * Uses the publishable key (public read on jobs). Run: pnpm smoke
 */
import { createClient } from "@supabase/supabase-js";
import { executeTool, TOOL_DEFINITIONS } from "../src/lib/agent/tools";
import { SYSTEM_PROMPT } from "../src/lib/agent/prompt";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://xrbnekghcswgotsauxok.supabase.co";
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_shSOwwHUzFv_7MH9iM3u_w_Sm0CzSIg";

async function main() {
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const ctx = { supabase, userId: "00000000-0000-0000-0000-000000000000", conversationId: "smoke" };

  console.log(`system prompt ≈ ${Math.round(SYSTEM_PROMPT.length / 4)} tokens, ${TOOL_DEFINITIONS.length} tools`);

  const facets = await executeTool("job_facets", { regions: ["lakewood"], categories: ["bookkeeping-accounting"] }, ctx);
  console.log("job_facets:", facets.label);

  const search = await executeTool("search_jobs", { q: "bookkeeper quickbooks", regions: ["lakewood", "brooklyn"], any_tags: ["sched:part-time", "sched:kollel-hours"], limit: 10 }, ctx);
  console.log("search_jobs:", search.label);
  const parsed = JSON.parse(search.result) as { count: number; jobs: { id: number; title: string }[] };
  console.log(`  first rows: ${parsed.jobs.slice(0, 3).map((j) => `#${j.id} ${j.title}`).join(" | ")}`);
  console.log(`  bytes per row ≈ ${Math.round(search.result.length / Math.max(1, parsed.count))}`);

  if (parsed.jobs[0]) {
    const one = await executeTool("get_job", { id: parsed.jobs[0].id }, ctx);
    console.log("get_job:", one.label);
    const present = await executeTool(
      "present_jobs",
      { tiers: [{ tier: "strong", jobs: [{ id: parsed.jobs[0].id, why: "Smoke test reason.", concerns: null }] }] },
      ctx,
    );
    console.log("present_jobs:", present.label, "| tiers:", present.tiers?.length, "| card title:", present.tiers?.[0]?.jobs[0]?.title);
  }

  const bad = await executeTool("search_jobs", { limit: 999 }, ctx);
  console.log("invalid input handled:", bad.result.startsWith("INVALID_INPUT"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
