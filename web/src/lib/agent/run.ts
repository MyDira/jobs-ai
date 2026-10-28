import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { addUsage, debit, getBalance, priceUsage, ZERO_USAGE, type Usage } from "@/lib/credits";
import { SYSTEM_PROMPT } from "./prompt";
import { executeTool, TOOL_DEFINITIONS, type PresentedTier } from "./tools";
import { buildCandidateContext, hashContext, loadCurrentResume, loadProfile } from "./context";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

/** Events streamed to the browser, one JSON object per SSE message. */
export type AgentEvent =
  | { type: "meta"; conversationId: string; userMessageId: string }
  | { type: "segment"; index: number } // a new model call begins (new assistant bubble)
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; label: string; isError: boolean }
  | { type: "jobs"; tiers: PresentedTier[] }
  | { type: "call_usage"; call: number; model: string; usage: Usage; costMicros: number; turnCostMicros: number; balanceMicros: number }
  | { type: "done"; stopReason: string; turnCostMicros: number; balanceMicros: number; exhausted: boolean }
  | { type: "error"; message: string };

export type StoredMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  kind: "user" | "assistant" | "tool_result" | "system";
  content: unknown;
  ui: unknown;
  cost_micros: number;
  usage: Usage | null;
  created_at: string;
};

export type AssistantUi = {
  text: string;
  tools: { id: string; name: string; label: string; isError: boolean }[];
  tiers: PresentedTier[];
  model: string;
  stopReason: string | null;
};

const MAX_TOKENS = 12_000;

/** Converts stored rows into the exact message list the API saw before, append-only. */
export function rowsToMessages(rows: StoredMessage[]): BetaMessageParam[] {
  return rows.map((r) => ({ role: r.role, content: r.content } as BetaMessageParam));
}

function extractUsage(u: Anthropic.Beta.BetaUsage): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };
}

export async function runTurn(opts: {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
  userText: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { supabase, userId, conversationId, userText, emit } = opts;
  const model = env.agentModel();
  const effort = env.agentEffort();
  const maxCalls = env.agentMaxCalls();
  const client = new Anthropic();

  // Conversation + lock (one turn at a time per conversation).
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .select("id, mode, context_version, title, updated_at, running")
    .eq("id", conversationId)
    .single();
  if (convoErr || !convo) {
    emit({ type: "error", message: "Conversation not found." });
    return;
  }
  const stale = convo.running && Date.now() - new Date(convo.updated_at).getTime() > 10 * 60_000;
  const { data: locked } = await supabase
    .from("conversations")
    .update({ running: true, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .or(stale ? "running.eq.true,running.eq.false" : "running.eq.false")
    .select("id");
  if (!locked || locked.length === 0) {
    emit({ type: "error", message: "This conversation is already answering. Wait for it to finish." });
    return;
  }

  let balance = await getBalance(userId);
  let turnUsage: Usage = { ...ZERO_USAGE };
  let turnCost = 0;
  let exhausted = false;
  let stopReason = "end_turn";
  let lastAssistantId: string | null = null;
  let callsMade = 0;

  try {
    // History and context
    const { data: rowsData } = await supabase
      .from("messages")
      .select("id, seq, role, kind, content, ui, cost_micros, usage, created_at")
      .eq("conversation_id", conversationId)
      .order("seq", { ascending: true });
    const rows = (rowsData as StoredMessage[]) ?? [];
    let seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const messages = rowsToMessages(rows);

    const [profile, resume] = await Promise.all([loadProfile(supabase, userId), loadCurrentResume(supabase, userId)]);
    const context = buildCandidateContext({
      profile,
      resume,
      mode: convo.mode as "chat" | "interview",
      today: new Date().toISOString().slice(0, 10),
    });
    const contextHash = hashContext(context.replace(/^Today: .*$/m, "")); // date alone should not re-inject

    const isFirstTurn = rows.length === 0;
    const userContent: Anthropic.Beta.BetaContentBlockParam[] = isFirstTurn
      ? [
          { type: "text", text: context },
          { type: "text", text: userText },
        ]
      : [{ type: "text", text: userText }];

    const { data: userRow, error: userErr } = await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "user", kind: "user", content: userContent, ui: { text: userText } })
      .select("id")
      .single();
    if (userErr || !userRow) throw new Error(`Could not save message: ${userErr?.message}`);
    emit({ type: "meta", conversationId, userMessageId: userRow.id });
    messages.push({ role: "user", content: userContent });

    // Context changed since it was last injected (mode toggle, new resume, profile edit): append, never rewrite.
    const contextChanged = !isFirstTurn && convo.context_version !== contextHash;
    if (contextChanged) {
      const note = `Updated candidate context (supersedes earlier context):\n${context}`;
      const { error: sysErr } = await supabase
        .from("messages")
        .insert({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "system", kind: "system", content: note, ui: null });
      if (sysErr) throw new Error(sysErr.message);
      messages.push({ role: "system", content: note } as BetaMessageParam);
    }
    if (isFirstTurn || contextChanged) {
      await supabase.from("conversations").update({ context_version: contextHash }).eq("id", conversationId);
    }
    if (isFirstTurn) {
      const title = userText.replace(/\s+/g, " ").slice(0, 60) + (userText.length > 60 ? "…" : "");
      await supabase.from("conversations").update({ title }).eq("id", conversationId);
    }

    for (let call = 0; call < maxCalls; call++) {
      emit({ type: "segment", index: call });
      const started = Date.now();
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
          fallbacks: "default",
          thinking: { type: "adaptive", display: "updates" },
          output_config: { effort },
          cache_control: { type: "ephemeral" },
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOL_DEFINITIONS,
          messages,
        },
        { signal: opts.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") emit({ type: "text", delta: event.delta.text });
          else if (event.delta.type === "thinking_delta" && event.delta.thinking) emit({ type: "thinking", delta: event.delta.thinking });
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          emit({ type: "tool_start", id: event.content_block.id, name: event.content_block.name });
        }
      }
      const message = await stream.finalMessage();
      callsMade++;
      const servedModel = message.model || model;
      const usage = extractUsage(message.usage);
      const cost = priceUsage(servedModel, usage);
      turnUsage = addUsage(turnUsage, usage);
      turnCost += cost;
      stopReason = message.stop_reason ?? "end_turn";

      await supabase.from("agent_calls").insert({
        user_id: userId,
        conversation_id: conversationId,
        call_index: call,
        model: servedModel,
        effort,
        ...usage,
        cost_micros: cost,
        stop_reason: stopReason,
        duration_ms: Date.now() - started,
      });
      emit({ type: "call_usage", call, model: servedModel, usage, costMicros: cost, turnCostMicros: turnCost, balanceMicros: balance - turnCost });

      const content = message.content as BetaContentBlock[];
      const text = content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("");
      const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const ui: AssistantUi = { text, tools: [], tiers: [], model: servedModel, stopReason };

      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "The assistant declined to answer this request." });
      }
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        emit({ type: "error", message: "The answer was cut off before a search could run. Please try again with a shorter request." });
      }
      const runTools = toolUses.length > 0 && message.stop_reason === "tool_use";

      // Persist assistant content verbatim (thinking blocks included) for an append-only replay.
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      if (runTools) {
        for (const tu of toolUses) {
          const outcome = await executeTool(tu.name, tu.input, { supabase, userId, conversationId });
          const isError = outcome.result.startsWith("ERROR") || outcome.result.startsWith("INVALID_INPUT");
          ui.tools.push({ id: tu.id, name: tu.name, label: outcome.label, isError });
          if (outcome.tiers) {
            ui.tiers.push(...outcome.tiers);
            emit({ type: "jobs", tiers: outcome.tiers });
          }
          emit({ type: "tool_end", id: tu.id, name: tu.name, label: outcome.label, isError });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: outcome.result, is_error: isError || undefined });
        }
      }

      const { data: aRow } = await supabase
        .from("messages")
        .insert({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "assistant", kind: "assistant", content, ui, cost_micros: cost, usage })
        .select("id")
        .single();
      lastAssistantId = aRow?.id ?? null;
      messages.push({ role: "assistant", content: content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

      if (!runTools) break;

      await supabase.from("messages").insert({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "user", kind: "tool_result", content: toolResults, ui: null });
      messages.push({ role: "user", content: toolResults });

      if (balance - turnCost <= 0) {
        exhausted = true;
        break;
      }
      if (call === maxCalls - 1) {
        emit({ type: "error", message: "Stopped after the maximum number of steps for one turn. Ask me to continue." });
      }
    }
  } catch (err) {
    const msg =
      err instanceof Anthropic.RateLimitError
        ? "The model is busy right now. Try again in a moment."
        : err instanceof Anthropic.AuthenticationError
          ? "The server's Anthropic API key is missing or invalid."
          : err instanceof Anthropic.APIError
            ? `Model error (${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : "Unknown error";
    emit({ type: "error", message: msg });
  } finally {
    if (turnCost > 0) {
      try {
        balance = await debit(userId, turnCost, {
          conversation_id: conversationId,
          message_id: lastAssistantId ?? undefined,
          model,
          calls: callsMade,
          ...turnUsage,
          note: "Chat turn",
        });
      } catch (e) {
        emit({ type: "error", message: `Could not record usage: ${(e as Error).message}` });
      }
    }
    await supabase.from("conversations").update({ running: false, updated_at: new Date().toISOString() }).eq("id", conversationId);
    emit({ type: "done", stopReason, turnCostMicros: turnCost, balanceMicros: balance, exhausted });
  }
}
