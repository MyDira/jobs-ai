import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getBalance } from "@/lib/credits";
import { runTurn, type AgentEvent } from "@/lib/agent/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST { conversationId, text } → text/event-stream of AgentEvent JSON objects.
 * The turn runs to completion server-side even if the client disconnects, so usage is always recorded.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { conversationId?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  const conversationId = body.conversationId ?? "";
  if (!text || !conversationId) return NextResponse.json({ error: "Missing text or conversation" }, { status: 400 });
  if (text.length > 8000) return NextResponse.json({ error: "Message too long (8000 characters max)" }, { status: 400 });

  const balance = await getBalance(user.id);
  if (balance < env.turnReserveMicros()) {
    return NextResponse.json({ error: "out_of_credits", balanceMicros: balance }, { status: 402 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const keepAlive = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            closed = true;
          }
        }
      }, 15_000);
      runTurn({ supabase, userId: user.id, conversationId, userText: text, emit })
        .catch((err) => emit({ type: "error", message: (err as Error).message }))
        .finally(() => {
          clearInterval(keepAlive);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {}
          }
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
