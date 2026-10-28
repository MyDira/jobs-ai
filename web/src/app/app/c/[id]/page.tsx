import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBalance } from "@/lib/credits";
import { env } from "@/lib/env";
import { Chat, type Turn } from "@/components/Chat";
import type { StoredMessage, AssistantUi } from "@/lib/agent/run";
import { loadCurrentResume } from "@/lib/agent/context";

export const dynamic = "force-dynamic";

function rowsToTurns(rows: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const r of rows) {
    if (r.kind === "user") {
      const ui = r.ui as { text?: string } | null;
      turns.push({ id: r.id, user: ui?.text ?? "", segments: [], costMicros: 0, status: "done" });
    } else if (r.kind === "assistant" && turns.length) {
      const ui = (r.ui as AssistantUi | null) ?? { text: "", tools: [], tiers: [], model: "", stopReason: null };
      const t = turns[turns.length - 1];
      t.segments.push({ text: ui.text ?? "", thinking: "", tools: (ui.tools ?? []).map((x) => ({ ...x, done: true })), tiers: ui.tiers ?? [] });
      t.costMicros += Number(r.cost_micros ?? 0);
    }
  }
  return turns;
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: convo } = await supabase.from("conversations").select("id, title, mode").eq("id", id).maybeSingle();
  if (!convo) notFound();

  const [{ data: rows }, balance, resume] = await Promise.all([
    supabase
      .from("messages")
      .select("id, seq, role, kind, content, ui, cost_micros, usage, created_at")
      .eq("conversation_id", id)
      .order("seq", { ascending: true }),
    getBalance(user.id),
    loadCurrentResume(supabase, user.id),
  ]);

  return (
    <Chat
      conversationId={convo.id}
      title={convo.title}
      mode={convo.mode as "chat" | "interview"}
      initialTurns={rowsToTurns((rows as StoredMessage[]) ?? [])}
      initialBalanceMicros={balance}
      reserveMicros={env.turnReserveMicros()}
      hasResume={Boolean(resume)}
    />
  );
}
