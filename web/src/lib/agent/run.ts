import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { addUsage, debit, formatMicros, getBalance, priceUsage, ZERO_USAGE, type Usage } from "@/lib/credits";
import { SYSTEM_PROMPT } from "./prompt";
import { executeTool, TOOL_DEFINITIONS, type PresentedTier } from "./tools";
import { buildCandidateContext, hashContext, loadCurrentResume, loadProfile } from "./context";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

/** Events streamed to the browser, one JSON object per SSE message. */
export type AgentEvent =
  | { type: "meta"; conversationId: string; userMessageId: string | null }
  | { type: "segment"; index: number } // a new model call begins
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; label: string; isError: boolean }
  | { type: "jobs"; tiers: PresentedTier[] }
  | { type: "call_usage"; call: number; model: string; usage: Usage; costMicros: number; turnCostMicros: number; balanceMicros: number }
  | {
      type: "done";
      stopReason: string;
      turnCostMicros: number;
      balanceMicros: number;
      exhausted: boolean;
      /** The turn is not finished; the client should POST { continue: true } to carry on. */
      needsContinue: boolean;
    }
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
  return rows.map((r) => ({ role: r.role, content: r.content }) as BetaMessageParam);
}

/** A conversation whose last stored row is not an assistant reply has an unfinished turn. */
export function hasPendingTurn(rows: Pick<StoredMessage, "kind">[]): boolean {
  return rows.length > 0 && rows[rows.length - 1].kind !== "assistant";
}

function extractUsage(u: Anthropic.Beta.BetaUsage): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };
}

/** A lock older than this is treated as abandoned (the server was stopped mid-request). */
function staleLockMs() {
  return env.requestBudgetMs() + 90_000;
}

/**
 * Runs one HTTP request's worth of a chat turn. With `userText`, starts a new turn. With
 * `continueTurn`, resumes an unfinished one from the stored messages. Stops starting new model
 * calls once the request budget is spent and tells the client to continue, so a turn of several
 * calls fits hosts with short function time limits (Netlify).
 */
export async function runTurn(opts: {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
  userText: string | null;
  continueTurn: boolean;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { supabase, userId, conversationId, userText, continueTurn, emit } = opts;
  const requestStarted = Date.now();
  const model = env.agentModel();
  const effort = env.agentEffort();
  const maxCalls = env.agentMaxCalls();
  const budgetMs = env.requestBudgetMs();
  const billing = env.billingEnabled();
  const client = new Anthropic();

  // Conversation + lock (one request at a time per conversation).
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .select("id, mode, context_version, title, updated_at, running")
    .eq("id", conversationId)
    .single();
  if (convoErr || !convo) {
    emit({ type: "error", message: "Conversation not found." });
    return;
  }
  const stale = convo.running && Date.now() - new Date(convo.updated_at).getTime() > staleLockMs();
  const { data: locked } = await supabase
    .from("conversations")
    .update({ running: true, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .or(stale ? "running.eq.true,running.eq.false" : "running.eq.false")
    .select("id");
  if (!locked || locked.length === 0) {
    emit({ type: "error", message: "This conversation is still working on the previous message. Wait a moment and try again." });
    return;
  }

  let balance = await getBalance(userId);
  let turnUsage: Usage = { ...ZERO_USAGE };
  let turnCost = 0;
  let exhausted = false;
  let needsContinue = false;
  let stopReason = "end_turn";
  let lastAssistantId: string | null = null;
  let callsMade = 0;

  try {
    const { data: rowsData } = await supabase
      .from("messages")
      .select("id, seq, role, kind, content, ui, cost_micros, usage, created_at")
      .eq("conversation_id", conversationId)
      .order("seq", { ascending: true });
    const rows = (rowsData as StoredMessage[]) ?? [];
    let seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const messages = rowsToMessages(rows);

    // Model calls already made in this turn (since the last user message), for the per-turn cap.
    let lastUserIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "user") { lastUserIdx = i; break; }
    let callsThisTurn = continueTurn ? rows.slice(lastUserIdx + 1).filter((r) => r.kind === "assistant").length : 0;

    if (continueTurn) {
      if (!hasPendingTurn(rows)) {
        emit({ type: "meta", conversationId, userMessageId: null });
        return; // nothing to continue; finally{} still emits done
      }
      emit({ type: "meta", conversationId, userMessageId: rows[lastUserIdx]?.id ?? null });
    } else {
      const text = userText ?? "";
      const [profile, resume] = await Promise.all([loadProfile(supabase, userId), loadCurrentResume(supabase, userId)]);
      const context = buildCandidateContext({
        profile,
        resume,
        mode: convo.mode as "chat" | "interview",
        today: new Date().toISOString().slice(0, 10),
      });
      const contextHash = hashContext(context.replace(/^Today: .*$/m, "")); // the date alone should not re-inject

      const isFirstTurn = rows.length === 0;
      const userContent: Anthropic.Beta.BetaContentBlockParam[] = isFirstTurn
        ? [
            { type: "text", text: context },
            { type: "text", text },
          ]
        : [{ type: "text", text }];

      const { data: userRow, error: userErr } = await supabase
        .from("messages")
        .insert({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "user", kind: "user", content: userContent, ui: { text } })
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
        const title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
        await supabase.from("conversations").update({ title }).eq("id", conversationId);
      }
    }

    for (let call = 0; ; call++) {
      if (callsThisTurn >= maxCalls) {
        emit({ type: "error", message: "Stopped after the maximum number of steps for one message. Ask me to continue." });
        break;
      }
      if (call > 0 && Date.now() - requestStarted > budgetMs) {
        needsContinue = true; // hand back to the client before the host's time limit
        break;
      }

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
      callsThisTurn++;
      const servedModel = message.model || model;
      const usage = extractUsage(message.usage);
      const cost = priceUsage(servedModel, usage);
      turnUsage = addUsage(turnUsage, usage);
      turnCost += cost;
      stopReason = message.stop_reason ?? "end_turn";

      await supabase.from("agent_calls").insert({
        user_id: userId,
        conversation_id: conversationId,
        call_index: callsThisTurn - 1,
        model: servedModel,
        effort,
        ...usage,
        cost_micros: cost,
        stop_reason: stopReason,
        duration_ms: Date.now() - started,
      });
      emit({
        type: "call_usage",
        call,
        model: servedModel,
        usage,
        costMicros: cost,
        turnCostMicros: turnCost,
        balanceMicros: billing ? balance - turnCost : balance,
      });

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

      // Assistant content is stored verbatim (thinking blocks included) for an append-only replay.
      // The assistant row and its tool results go in one insert, so a stopped server never leaves
      // a tool_use without its tool_result.
      const toInsert: Record<string, unknown>[] = [
        { conversation_id: conversationId, user_id: userId, seq: seq++, role: "assistant", kind: "assistant", content, ui, cost_micros: cost, usage },
      ];
      if (runTools) {
        toInsert.push({ conversation_id: conversationId, user_id: userId, seq: seq++, role: "user", kind: "tool_result", content: toolResults, ui: null });
      }
      const { data: inserted, error: insErr } = await supabase.from("messages").insert(toInsert).select("id, kind");
      if (insErr) throw new Error(`Could not save the reply: ${insErr.message}`);
      lastAssistantId = inserted?.find((r) => r.kind === "assistant")?.id ?? null;
      messages.push({ role: "assistant", content: content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

      if (!runTools) break;
      messages.push({ role: "user", content: toolResults });

      if (billing && balance - turnCost <= 0) {
        exhausted = true;
        break;
      }
      // Keep the lock fresh so a long turn is not mistaken for an abandoned one.
      await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
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
        // While billing is off, a zero-amount row still records the tokens and what it would have cost.
        balance = await debit(userId, billing ? turnCost : 0, {
          conversation_id: conversationId,
          message_id: lastAssistantId ?? undefined,
          model,
          calls: callsMade,
          ...turnUsage,
          note: billing ? "Chat turn" : `Free testing · would cost ${formatMicros(turnCost, 4)}`,
        });
      } catch (e) {
        emit({ type: "error", message: `Could not record usage: ${(e as Error).message}` });
      }
    }
    await supabase.from("conversations").update({ running: false, updated_at: new Date().toISOString() }).eq("id", conversationId);
    emit({ type: "done", stopReason, turnCostMicros: turnCost, balanceMicros: balance, exhausted, needsContinue });
  }
}
