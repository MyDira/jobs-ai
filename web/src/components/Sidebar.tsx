"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { createConversation } from "@/app/app/actions";
import { formatMicros } from "@/lib/credits";

type Convo = { id: string; title: string; mode: string; updated_at: string };

export function Sidebar({ conversations, balanceMicros, email }: { conversations: Convo[]; balanceMicros: number; email: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const low = balanceMicros < 1_000_000;

  const nav = (
    <>
      <div className="flex items-center justify-between px-3 pt-4">
        <Link href="/app" className="font-semibold tracking-tight">Jobs AI</Link>
        <button className="rounded-md border border-line px-2 py-1 text-xs lg:hidden" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="px-3 pt-4">
        <button
          disabled={pending}
          onClick={() => start(() => createConversation("chat"))}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          {pending ? "Opening…" : "New conversation"}
        </button>
      </div>
      <nav className="mt-4 flex-1 overflow-y-auto px-2">
        {conversations.length === 0 && <p className="px-2 text-xs text-muted">No conversations yet.</p>}
        {conversations.map((c) => {
          const active = pathname === `/app/c/${c.id}`;
          return (
            <Link
              key={c.id}
              href={`/app/c/${c.id}`}
              onClick={() => setOpen(false)}
              className={`block truncate rounded-md px-2 py-1.5 text-sm ${active ? "bg-soft font-medium" : "text-muted hover:bg-soft hover:text-fg"}`}
              title={c.title}
            >
              {c.mode === "interview" && <span className="mr-1 text-xs" aria-label="interview">🎙</span>}
              {c.title}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line px-3 py-3 text-sm">
        <Link href="/app/credits" className={`flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-soft ${pathname === "/app/credits" ? "bg-soft" : ""}`}>
          <span>Credits</span>
          <span className={`font-mono ${low ? "text-red-600" : ""}`}>{formatMicros(balanceMicros)}</span>
        </Link>
        <Link href="/app/profile" className={`block rounded-md px-2 py-1.5 hover:bg-soft ${pathname === "/app/profile" ? "bg-soft" : ""}`}>Profile &amp; resume</Link>
        <form action="/auth/signout" method="post" className="mt-1 flex items-center justify-between px-2 py-1.5 text-xs text-muted">
          <span className="truncate" title={email}>{email}</span>
          <button className="underline">Sign out</button>
        </form>
      </div>
    </>
  );

  return (
    <>
      <button className="fixed left-3 top-3 z-20 rounded-md border border-line bg-panel px-2 py-1 text-xs lg:hidden" onClick={() => setOpen(true)}>Menu</button>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex">{nav}</aside>
      {open && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <aside className="flex w-72 flex-col bg-panel shadow-xl">{nav}</aside>
          <div className="flex-1 bg-black/40" onClick={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
