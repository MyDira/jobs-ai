"use client";

import { useState } from "react";
import type { JobCardData, PresentedTier, TierName } from "@/lib/agent/tools";

const TIER_META: Record<TierName, { label: string; blurb: string; cls: string }> = {
  perfect: { label: "Perfect fit", blurb: "Role, place, hours and pay all line up.", cls: "border-emerald-500/50 bg-emerald-500/5" },
  strong: { label: "Strong", blurb: "One soft mismatch to check.", cls: "border-sky-500/50 bg-sky-500/5" },
  possible: { label: "Worth a look", blurb: "A stretch or a pivot your background could support.", cls: "border-amber-500/50 bg-amber-500/5" },
  fallback: { label: "Pays the bills", blurb: "Quick-start options that meet your hard constraints.", cls: "border-line bg-soft" },
};

const SOURCE_NAMES: Record<string, string> = {
  macherusa: "MacherUSA", bpweekly: "BP Weekly", jewishjobs: "JewishJobs.com", yidjob: "YidJob", bpview: "The Boro Park View",
  weeklylink: "The Weekly Link", luach: "luach.com", vol: "The Voice of Lakewood", fjj: "Flatbush Jewish Journal",
  torahtimes: "Torah Times", jewishpress: "Jewish Press classifieds",
};

export function TierList({ tiers }: { tiers: PresentedTier[] }) {
  return (
    <div className="my-3 space-y-4">
      {tiers.map((t, i) => {
        const meta = TIER_META[t.tier];
        return (
          <section key={`${t.tier}-${i}`} className={`rounded-lg border p-3 ${meta.cls}`}>
            <header className="mb-2">
              <h3 className="text-sm font-semibold">{meta.label} <span className="font-normal text-muted">· {t.jobs.length}</span></h3>
              <p className="text-xs text-muted">{t.headline ?? meta.blurb}</p>
            </header>
            <div className="space-y-2">
              {t.jobs.map((j) => <JobCard key={j.id} job={j} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function pay(j: JobCardData) {
  if (j.salary) return j.salary;
  if (j.salary_annual_est) return `~$${Math.round(Number(j.salary_annual_est)).toLocaleString()}/yr est.`;
  return null;
}

export function JobCard({ job: j }: { job: JobCardData }) {
  const [open, setOpen] = useState(false);
  const place = j.location ?? j.town ?? j.region;
  const chips = [j.schedule, j.work_mode && j.work_mode !== "onsite" ? j.work_mode : null, pay(j), j.gender_pref && j.gender_pref !== "any" ? `${j.gender_pref} only` : null].filter(Boolean) as string[];
  return (
    <article className="rounded-md border border-line bg-panel p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-medium leading-snug">{j.title ?? "Untitled listing"}</h4>
          <p className="text-muted">{[j.company, place].filter(Boolean).join(" · ") || "Company not named"}</p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg">
          {open ? "Less" : "Details"}
        </button>
      </div>
      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((c) => <span key={c} className="rounded-full bg-soft px-2 py-0.5 text-xs">{c}</span>)}
        </div>
      )}
      <p className="mt-2">{j.why}</p>
      {j.concerns && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Watch for: {j.concerns}</p>}
      {open && (
        <div className="mt-3 space-y-2 border-t border-line pt-3 text-xs">
          {(j.summary || j.description) && <p className="whitespace-pre-wrap">{j.description ?? j.summary}</p>}
          <dl className="grid gap-1 sm:grid-cols-2">
            {j.how_to_apply && <Row k="How to apply" v={j.how_to_apply} />}
            {j.contact_phone && <Row k="Phone" v={<a className="underline" href={`tel:${j.contact_phone}`}>{j.contact_phone}</a>} />}
            {j.contact_email && <Row k="Email" v={<a className="underline" href={`mailto:${j.contact_email}`}>{j.contact_email}</a>} />}
            {j.contact_other && <Row k="Contact" v={j.contact_other} />}
            {j.url && <Row k="Listing" v={<a className="underline" href={j.url} target="_blank" rel="noreferrer noopener">Open original</a>} />}
            <Row k="Source" v={`${SOURCE_NAMES[j.source ?? ""] ?? j.source ?? "?"}${j.found_date ? ` · found ${j.found_date}` : ""}${j.times_seen && j.times_seen > 1 ? ` · seen ${j.times_seen}×` : ""}`} />
            {j.tags.length > 0 && <Row k="Tags" v={j.tags.filter((t) => !t.startsWith("kw:") && !t.startsWith("src:")).join(", ")} />}
          </dl>
          <p className="text-muted">Listing #{j.id}</p>
        </div>
      )}
    </article>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
