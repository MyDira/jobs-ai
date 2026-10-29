import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export type ToolContext = {
  supabase: SupabaseClient; // the user's client: RLS and auth.uid() apply
  userId: string;
  conversationId: string;
};

/** What the UI renders for a shortlist. Built server-side from present_jobs input + DB rows. */
export type JobCardData = {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  town: string | null;
  region: string | null;
  category: string | null;
  tags: string[];
  summary: string | null;
  description: string | null;
  salary: string | null;
  salary_annual_est: number | null;
  schedule: string | null;
  work_mode: string | null;
  gender_pref: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  contact_other: string | null;
  how_to_apply: string | null;
  url: string | null;
  source: string | null;
  found_date: string | null;
  last_seen: string | null;
  times_seen: number | null;
  why: string;
  concerns: string | null;
};

export type TierName = "perfect" | "strong" | "possible" | "fallback";
export type PresentedTier = { tier: TierName; headline: string | null; jobs: JobCardData[] };

export type ToolOutcome = {
  result: string; // what the model sees
  label: string; // one line for the UI activity chip
  tiers?: PresentedTier[]; // only for present_jobs
};

const REGIONS = ["lakewood", "brooklyn", "nyc-other", "long-island", "rockland", "nj-other", "remote", "other", "unknown"] as const;

const str = z.string().min(1).max(200);
const strArr = z.array(str).max(12).optional().nullable();

export const schemas = {
  job_facets: z.object({
    q: z.string().max(200).optional().nullable(),
    regions: z.array(z.enum(REGIONS)).max(9).optional().nullable(),
    categories: strArr,
    any_tags: strArr,
    gender: z.enum(["women", "men"]).optional().nullable(),
    min_pay: z.number().min(0).max(1_000_000).optional().nullable(),
  }),
  search_jobs: z.object({
    q: z.string().max(200).optional().nullable(),
    categories: strArr,
    any_tags: strArr,
    all_tags: strArr,
    exclude_tags: strArr,
    regions: z.array(z.enum(REGIONS)).max(9).optional().nullable(),
    gender: z.enum(["women", "men"]).optional().nullable(),
    min_pay: z.number().min(0).max(1_000_000).optional().nullable(),
    found_since_days: z.number().int().min(1).max(90).optional().nullable(),
    sort: z.enum(["auto", "relevance", "newest", "pay"]).optional().nullable(),
    limit: z.number().int().min(1).max(40).optional().nullable(),
    offset: z.number().int().min(0).max(500).optional().nullable(),
  }),
  get_job: z.object({ id: z.number().int().positive() }),
  present_jobs: z.object({
    tiers: z
      .array(
        z.object({
          tier: z.enum(["perfect", "strong", "possible", "fallback"]),
          headline: z.string().max(200).optional().nullable(),
          jobs: z
            .array(
              z.object({
                id: z.number().int().positive(),
                why: z.string().min(1).max(600),
                concerns: z.string().max(400).optional().nullable(),
              }),
            )
            .max(10),
        }),
      )
      .min(1)
      .max(4),
  }),
  update_candidate_profile: z.object({
    target_roles: z.array(str).max(10).optional().nullable(),
    locations: z.array(str).max(10).optional().nullable(),
    schedule: z.string().max(200).optional().nullable(),
    work_mode: z.enum(["onsite", "remote", "hybrid", "any"]).optional().nullable(),
    pay_floor_annual: z.number().min(0).max(1_000_000).optional().nullable(),
    pay_wish_annual: z.number().min(0).max(1_000_000).optional().nullable(),
    gender: z.enum(["women", "men"]).optional().nullable(),
    languages: z.array(str).max(6).optional().nullable(),
    dealbreakers: z.array(str).max(10).optional().nullable(),
    strengths: z.array(str).max(10).optional().nullable(),
    notes: z.string().max(1500).optional().nullable(),
    insights: z.string().max(3000).optional().nullable(),
  }),
  mark_job: z.object({
    id: z.number().int().positive(),
    status: z.enum(["interested", "applied", "interviewing", "rejected", "hidden"]),
    note: z.string().max(500).optional().nullable(),
  }),
};

export type ToolName = keyof typeof schemas;

/**
 * Tool definitions sent to the model. Declared on every request, in this fixed order, so the
 * cached prefix stays identical and preserved-thinking checks pass.
 */
export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "job_facets",
    description:
      "Counts of active, de-duplicated listings grouped by region, category, schedule and work mode under optional filters. Use it to see what the market holds before narrowing, and to explain thin results.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Full-text keywords (e.g. 'bookkeeper quickbooks')." },
        regions: { type: "array", items: { type: "string", enum: [...REGIONS] } },
        categories: { type: "array", items: { type: "string" }, description: "cat: values, with or without the prefix." },
        any_tags: { type: "array", items: { type: "string" }, description: "Match listings having any of these family:value tags." },
        gender: { type: "string", enum: ["women", "men"], description: "Only pass when the person's gender is known. Excludes ads targeting the other gender." },
        min_pay: { type: "number", description: "Minimum estimated annual pay in USD." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_jobs",
    description:
      "Search active, de-duplicated listings. Combine free text (q) with categories, tags and regions. Returns compact rows (max 40). Sorted by relevance when q is given, else newest first; 'pay' sorts by estimated annual pay.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Plain keywords for full-text search over title, summary, description, tags, location." },
        categories: { type: "array", items: { type: "string" }, description: "cat: values; a listing matches if it has any of them." },
        any_tags: { type: "array", items: { type: "string" }, description: "family:value tags; match any." },
        all_tags: { type: "array", items: { type: "string" }, description: "family:value tags; listing must have all." },
        exclude_tags: { type: "array", items: { type: "string" }, description: "family:value tags to exclude (a cat: here excludes by primary category)." },
        regions: { type: "array", items: { type: "string", enum: [...REGIONS] } },
        gender: { type: "string", enum: ["women", "men"] },
        min_pay: { type: "number", description: "Minimum estimated annual pay in USD. Note: two thirds of ads state no pay and are excluded by this filter." },
        found_since_days: { type: "integer", description: "Only listings first found in the last N days." },
        sort: { type: "string", enum: ["auto", "relevance", "newest", "pay"] },
        limit: { type: "integer", description: "1-40, default 25." },
        offset: { type: "integer", description: "For paging." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description: "Full details for one listing: complete ad text, pay fields, contact details, how to apply, url, dates.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "present_jobs",
    description:
      "Show the person a tiered shortlist as cards. Only ids that appeared in earlier tool results in this conversation. Order tiers perfect, strong, possible, fallback; omit empty tiers. 'why' is 1-2 specific sentences grounded in the ad and the resume; 'concerns' names the catch, if any.",
    input_schema: {
      type: "object",
      properties: {
        tiers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tier: { type: "string", enum: ["perfect", "strong", "possible", "fallback"] },
              headline: { type: "string", description: "Optional one-line framing for this tier." },
              jobs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    why: { type: "string" },
                    concerns: { type: "string" },
                  },
                  required: ["id", "why"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tier", "jobs"],
            additionalProperties: false,
          },
        },
      },
      required: ["tiers"],
      additionalProperties: false,
    },
  },
  {
    name: "update_candidate_profile",
    description:
      "Save what you learned about the person. Fields merge into their saved profile and persist across conversations. Pass only fields you learned or that changed.",
    input_schema: {
      type: "object",
      properties: {
        target_roles: { type: "array", items: { type: "string" } },
        locations: { type: "array", items: { type: "string" }, description: "Towns/regions they will work in." },
        schedule: { type: "string", description: "e.g. 'part-time mornings', 'full-time', 'kollel hours'." },
        work_mode: { type: "string", enum: ["onsite", "remote", "hybrid", "any"] },
        pay_floor_annual: { type: "number" },
        pay_wish_annual: { type: "number" },
        gender: { type: "string", enum: ["women", "men"], description: "Only if the person stated it." },
        languages: { type: "array", items: { type: "string" } },
        dealbreakers: { type: "array", items: { type: "string" } },
        strengths: { type: "array", items: { type: "string" } },
        notes: { type: "string", description: "Short free-form facts worth remembering." },
        insights: { type: "string", description: "Your read of the person after an interview: what they should consider and why." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mark_job",
    description: "Record the person's status on a listing: interested, applied, interviewing, rejected, or hidden (never show again).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["interested", "applied", "interviewing", "rejected", "hidden"] },
        note: { type: "string" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
];

const CARD_COLUMNS =
  "id, title, company, location, town, region, category, tags, summary, description, salary, salary_annual_est, schedule, work_mode, gender_pref, contact_phone, contact_email, contact_other, how_to_apply, url, source, found_date, last_seen, times_seen";

type JobRow = Omit<JobCardData, "why" | "concerns">;

function compactRow(j: JobRow) {
  const pay = j.salary ?? (j.salary_annual_est ? `~$${Math.round(Number(j.salary_annual_est)).toLocaleString()}/yr est.` : null);
  return {
    id: j.id,
    title: j.title,
    company: j.company,
    place: j.location ?? j.town ?? j.region,
    region: j.region,
    schedule: j.schedule,
    mode: j.work_mode && j.work_mode !== "onsite" ? j.work_mode : undefined,
    gender: j.gender_pref && j.gender_pref !== "any" ? j.gender_pref : undefined,
    pay: pay ?? undefined,
    summary: j.summary ?? (j.description ? j.description.replace(/\s+/g, " ").slice(0, 220) : null),
    tags: (j.tags ?? []).filter((t) => !t.startsWith("kw:") && !t.startsWith("src:") && !t.startsWith("region:")),
    source: j.source,
    found: j.found_date,
    seen: j.times_seen,
  };
}

function normalizeCategories(cats?: string[] | null) {
  return cats?.map((c) => (c.startsWith("cat:") ? c : `cat:${c}`)) ?? null;
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in schemas)) return { result: `Unknown tool ${name}`, label: `Unknown tool ${name}` };
  const parsed = schemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success) {
    return { result: `INVALID_INPUT: ${parsed.error.message}`, label: `${name}: invalid input` };
  }
  const { supabase, userId } = ctx;

  switch (name as ToolName) {
    case "job_facets": {
      const i = parsed.data as z.infer<typeof schemas.job_facets>;
      const { data, error } = await supabase.rpc("job_facets", {
        q: i.q || null,
        regions: i.regions ?? null,
        categories: normalizeCategories(i.categories),
        any_tags: i.any_tags ?? null,
        gender: i.gender ?? null,
        min_pay: i.min_pay ?? null,
      });
      if (error) return { result: `ERROR: ${error.message}`, label: "Market counts failed" };
      const total = (data as { total?: number })?.total ?? 0;
      return { result: JSON.stringify(data), label: `Checked the market: ${total} active listings match` };
    }
    case "search_jobs": {
      const i = parsed.data as z.infer<typeof schemas.search_jobs>;
      const foundSince = i.found_since_days
        ? new Date(Date.now() - i.found_since_days * 86_400_000).toISOString().slice(0, 10)
        : null;
      const { data, error } = await supabase.rpc("search_jobs", {
        q: i.q || null,
        categories: normalizeCategories(i.categories),
        any_tags: i.any_tags ?? null,
        all_tags: i.all_tags ?? null,
        exclude_tags: i.exclude_tags ?? null,
        regions: i.regions ?? null,
        gender: i.gender ?? null,
        found_since: foundSince,
        min_pay: i.min_pay ?? null,
        sort: i.sort === "newest" ? "date" : (i.sort ?? "auto"),
        max_results: i.limit ?? 25,
        page_offset: i.offset ?? 0,
      });
      if (error) return { result: `ERROR: ${error.message}`, label: "Search failed" };
      const rows = (data as JobRow[]) ?? [];
      const desc = [i.q, i.categories?.join("/"), i.regions?.join("/"), i.any_tags?.join("/")].filter(Boolean).join(" · ");
      return {
        result: JSON.stringify({ count: rows.length, jobs: rows.map(compactRow) }),
        label: `Searched${desc ? ` "${desc}"` : ""}: ${rows.length} result${rows.length === 1 ? "" : "s"}`,
      };
    }
    case "get_job": {
      const i = parsed.data as z.infer<typeof schemas.get_job>;
      const { data, error } = await supabase.from("jobs").select(CARD_COLUMNS).eq("id", i.id).maybeSingle();
      if (error) return { result: `ERROR: ${error.message}`, label: "Lookup failed" };
      if (!data) return { result: `No listing with id ${i.id}`, label: `Listing ${i.id} not found` };
      const j = data as unknown as JobRow;
      return { result: JSON.stringify(j), label: `Read the full ad: ${j.title ?? "untitled"}${j.company ? ` at ${j.company}` : ""}` };
    }
    case "present_jobs": {
      const i = parsed.data as z.infer<typeof schemas.present_jobs>;
      const ids = [...new Set(i.tiers.flatMap((t) => t.jobs.map((j) => j.id)))];
      const { data, error } = await supabase.from("jobs").select(CARD_COLUMNS).in("id", ids);
      if (error) return { result: `ERROR: ${error.message}`, label: "Could not render shortlist" };
      const byId = new Map(((data as unknown as JobRow[]) ?? []).map((r) => [r.id, r]));
      const missing: number[] = [];
      const tiers: PresentedTier[] = i.tiers
        .map((t) => ({
          tier: t.tier,
          headline: t.headline ?? null,
          jobs: t.jobs.flatMap((j) => {
            const row = byId.get(j.id);
            if (!row) {
              missing.push(j.id);
              return [];
            }
            return [{ ...row, why: j.why, concerns: j.concerns ?? null }];
          }),
        }))
        .filter((t) => t.jobs.length > 0);
      const n = tiers.reduce((s, t) => s + t.jobs.length, 0);
      return {
        result: `Rendered ${n} job card${n === 1 ? "" : "s"} in ${tiers.length} tier${tiers.length === 1 ? "" : "s"}.${
          missing.length ? ` Ids not found and skipped: ${missing.join(", ")}.` : ""
        } Now write a short narrative; do not list the jobs again.`,
        label: `Presented ${n} job${n === 1 ? "" : "s"}`,
        tiers,
      };
    }
    case "update_candidate_profile": {
      const i = parsed.data as z.infer<typeof schemas.update_candidate_profile>;
      const { insights, notes, ...prefs } = i;
      const cleaned = Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== null && v !== undefined));
      const { data: existing } = await supabase
        .from("user_profiles")
        .select("id, preferences, interview_insights, notes")
        .eq("user_id", userId)
        .maybeSingle();
      const merged = { ...((existing?.preferences as Record<string, unknown>) ?? {}), ...cleaned };
      if (notes) merged.agent_notes = notes;
      const patch: Record<string, unknown> = { preferences: merged, updated_at: new Date().toISOString() };
      if (insights) patch.interview_insights = insights;
      const { error } = existing
        ? await supabase.from("user_profiles").update(patch).eq("user_id", userId)
        : await supabase.from("user_profiles").insert({ user_id: userId, name: "", ...patch });
      if (error) return { result: `ERROR: ${error.message}`, label: "Could not save profile" };
      return { result: `Saved. Profile now: ${JSON.stringify({ ...merged, interview_insights: patch.interview_insights ?? existing?.interview_insights ?? null })}`, label: "Updated your saved profile" };
    }
    case "mark_job": {
      const i = parsed.data as z.infer<typeof schemas.mark_job>;
      const { error } = await supabase
        .from("user_job_status")
        .upsert({ user_id: userId, job_id: i.id, status: i.status, notes: i.note ?? null, updated_at: new Date().toISOString() });
      if (error) return { result: `ERROR: ${error.message}`, label: "Could not update job status" };
      return { result: `Marked job ${i.id} as ${i.status}.`, label: `Marked listing ${i.id} as ${i.status}` };
    }
  }
}
