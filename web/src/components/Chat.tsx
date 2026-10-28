"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { setConversationMode } from "@/app/app/actions";
import type { AgentEvent } from "@/lib/agent/run";
import type { PresentedTier } from "@/lib/agent/tools";
import { formatMicros } from "@/lib/credits";
import { Markdown } from "./Markdown";
import { TierList } from "./JobCard";

export type ToolChip = { id: string; name: string; label: string; isError: boolean; done: boolean };
export type Segment = { text: string; thinking: string; tools: ToolChip[]; tiers: PresentedTier[] };
export type Turn = {
  id: string;
  user: string;
  segments: Segment[];
  costMicros: number;
  status: "done" | "streaming" | "error";
  error?: string;
  exhausted?: boolean;
};

const TOOL_LABELS: Record<string, string> = {
  job_facets: "Checking what the market holds…",
  search_jobs: "Searching listings…",
  get_job: "Reading the full ad…",
  present_jobs: "Building your shortlist…",
  update_candidate_profile: "Saving what I learned…",
  mark_job: "Updating the listing…",
};

const STARTERS = [
  "I'm a bookkeeper in Lakewood with 4 years of QuickBooks experience. Part-time mornings, ideally kollel hours.",
  "Looking for a full-time office job in Boro Park or Flatbush. I'm organized, good on the phone, and know Excel.",
  "I'm a special-ed teacher in Monsey thinking about leaving the classroom. What else could I do with my background?",
  "I need something that starts this week and pays at least $22 an hour. Brooklyn, any hours.",
];

export function Chat(props: {
  conversationId: string;
  title: string;
  mode: "chat" | "interview";
  initialTurns: Turn[];
  initialBalanceMicros: number;
  reserveMicros: number;
  hasResume: boolean;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>(props.initialTurns);
  const [balance, setBalance] = useState(props.initialBalanceMicros);
  const [mode, setMode] = useState(props.mode);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [outOfCredits, setOutOfCredits] = useState(props.initialBalanceMicros < props.reserveMicros);
  const [modePending, startMode] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTurns(props.initialTurns);
    setMode(props.mode);
    setBalance(props.initialBalanceMicros);
  }, [props.conversationId, props.initialTurns, props.mode, props.initialBalanceMicros]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, sending]);

  function patchLast(fn: (t: Turn) => void) {
    setTurns((prev) => {
      const next = prev.slice();
      const last = { ...next[next.length - 1], segments: next[next.length - 1].segments.map((s) => ({ ...s, tools: s.tools.slice(), tiers: s.tiers.slice() })) };
      fn(last);
      next[next.length - 1] = last;
      return next;
    });
  }

  function handleEvent(e: AgentEvent) {
    switch (e.type) {
      case "meta":
        patchLast((t) => { t.id = e.userMessageId; });
        break;
      case "segment":
        patchLast((t) => { t.segments.push({ text: "", thinking: "", tools: [], tiers: [] }); });
        break;
      case "text":
        patchLast((t) => { const s = t.segments[t.segments.length - 1]; if (s) s.text += e.delta; });
        break;
      case "thinking":
        patchLast((t) => { const s = t.segments[t.segments.length - 1]; if (s) s.thinking = (s.thinking + e.delta).slice(-400); });
        break;
      case "tool_start":
        patchLast((t) => { const s = t.segments[t.segments.length - 1]; if (s) s.tools.push({ id: e.id, name: e.name, label: TOOL_LABELS[e.name] ?? e.name, isError: false, done: false }); });
        break;
      case "tool_end":
        patchLast((t) => {
          const s = t.segments[t.segments.length - 1];
          const chip = s?.tools.find((c) => c.id === e.id);
          if (chip) { chip.label = e.label; chip.done = true; chip.isError = e.isError; }
        });
        break;
      case "jobs":
        patchLast((t) => { const s = t.segments[t.segments.length - 1]; if (s) s.tiers.push(...e.tiers); });
        break;
      case "call_usage":
        setBalance(e.balanceMicros);
        patchLast((t) => { t.costMicros = e.turnCostMicros; });
        break;
      case "error":
        patchLast((t) => { t.error = t.error ? `${t.error} ${e.message}` : e.message; });
        break;
      case "done":
        setBalance(e.balanceMicros);
        patchLast((t) => { t.costMicros = e.turnCostMicros; t.status = t.error ? "error" : "done"; t.exhausted = e.exhausted; });
        if (e.exhausted || e.balanceMicros < props.reserveMicros) setOutOfCredits(true);
        break;
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    if (balance < props.reserveMicros) { setOutOfCredits(true); return; }
    setInput("");
    setSending(true);
    setTurns((prev) => [...prev, { id: `tmp-${Date.now()}`, user: trimmed, segments: [], costMicros: 0, status: "streaming" }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: props.conversationId, text: trimmed }),
      });
      if (res.status === 402) {
        const data = await res.json().catch(() => ({}));
        if (typeof data.balanceMicros === "number") setBalance(data.balanceMicros);
        setOutOfCredits(true);
        patchLast((t) => { t.status = "error"; t.error = "You are out of credits. Add a pack to continue."; });
        return;
      }
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try { handleEvent(JSON.parse(line.slice(6)) as AgentEvent); } catch { /* ignore malformed */ }
          }
        }
      }
    } catch (e) {
      patchLast((t) => { t.status = "error"; t.error = (e as Error).message; });
    } finally {
      setSending(false);
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 && t.status === "streaming" ? { ...t, status: "done" } : t)));
      router.refresh(); // sidebar title + balance
      textareaRef.current?.focus();
    }
  }

  function toggleMode() {
    const next = mode === "interview" ? "chat" : "interview";
    setMode(next);
    startMode(() => setConversationMode(props.conversationId, next));
  }

  const empty = turns.length === 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 pl-16 lg:pl-4">
        <h1 className="truncate text-sm font-medium">{props.title}</h1>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex cursor-pointer items-center gap-2" title="When on, the agent asks you a short series of questions before searching, to find directions you may not have considered.">
            <span className={mode === "interview" ? "font-medium" : "text-muted"}>Interview mode</span>
            <button
              type="button"
              role="switch"
              aria-checked={mode === "interview"}
              disabled={modePending || sending}
              onClick={toggleMode}
              className={`relative h-5 w-9 rounded-full transition ${mode === "interview" ? "bg-accent" : "bg-line"}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${mode === "interview" ? "left-4.5 translate-x-0.5" : "left-0.5"}`} />
            </button>
          </label>
          <Link href="/app/credits" className={`rounded-full border border-line px-2 py-0.5 font-mono ${balance < 1_000_000 ? "text-red-600" : ""}`} title="Your credit balance">
            {formatMicros(balance)}
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {empty && (
            <div className="rounded-lg border border-line bg-panel p-5 text-sm">
              <p className="font-medium">Tell me what you are looking for.</p>
              <p className="mt-1 text-muted">
                Where, what hours, what kind of work, and anything that is a hard no. {props.hasResume ? "I have your resume." : (
                  <>You have not uploaded a resume yet; <Link href="/app/profile" className="text-accent underline">add one</Link> and I can judge fit instead of guessing.</>
                )}
                {mode === "interview" && " Interview mode is on, so I will ask you a few questions first."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => setInput(s)} className="rounded-md border border-line px-2.5 py-1.5 text-left text-xs text-muted hover:border-accent hover:text-fg">{s}</button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t) => (
            <div key={t.id} className="mb-6">
              <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-accent-fg">{t.user}</div>
              </div>
              <div className="mt-3 space-y-3">
                {t.segments.map((s, i) => (
                  <div key={i}>
                    {s.tools.length > 0 && (
                      <ul className="mb-2 space-y-1">
                        {s.tools.map((c) => (
                          <li key={c.id} className={`flex items-center gap-2 text-xs ${c.isError ? "text-red-600" : "text-muted"}`}>
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.done ? (c.isError ? "bg-red-500" : "bg-accent") : "animate-pulse bg-amber-500"}`} />
                            {c.label}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.tiers.length > 0 && <TierList tiers={s.tiers} />}
                    {s.text ? (
                      <div className="text-sm"><Markdown text={s.text} /></div>
                    ) : (
                      t.status === "streaming" && i === t.segments.length - 1 && (
                        <p className="text-xs italic text-muted">{s.thinking ? s.thinking.split("\n").filter(Boolean).pop() : "Thinking…"}</p>
                      )
                    )}
                  </div>
                ))}
                {t.status === "streaming" && t.segments.length === 0 && <p className="text-xs italic text-muted">Thinking…</p>}
                {t.error && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{t.error}</p>}
                {t.exhausted && <p className="text-xs text-amber-700 dark:text-amber-400">Credits ran out during this answer, so it stopped early.</p>}
                {t.status !== "streaming" && t.costMicros > 0 && (
                  <p className="text-right font-mono text-[11px] text-muted" title="What this answer cost">{formatMicros(t.costMicros, 4)}</p>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-line bg-panel">
        <div className="mx-auto max-w-3xl px-4 py-3">
          {outOfCredits && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30">
              <span>Balance {formatMicros(balance)}. Add credits to keep going; packs start at $5.</span>
              <Link href="/app/credits" className="rounded bg-accent px-2.5 py-1 font-medium text-accent-fg">Add credits</Link>
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); void send(input); }}
            className="flex items-end gap-2"
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              placeholder={sending ? "Working…" : "Message Jobs AI (Enter to send, Shift+Enter for a new line)"}
              disabled={sending}
              className="flex-1 resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm disabled:opacity-60"
            />
            <button disabled={sending || !input.trim() || outOfCredits} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">Send</button>
          </form>
          <p className="mt-1.5 text-[11px] text-muted">Listings come from this week&apos;s papers and job sites; always confirm details with the employer. Each reply shows its cost.</p>
        </div>
      </div>
    </div>
  );
}
