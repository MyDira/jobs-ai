"use client";

import Link from "next/link";
import { useActionState } from "react";
import { sendMagicLink, signIn, signUp, type AuthState } from "@/app/login/actions";

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const [state, action, pending] = useActionState(mode === "login" ? signIn : signUp, null as AuthState);
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, null as AuthState);

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Sign in" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-muted">
        {mode === "login" ? (
          <>New here? <Link className="text-accent underline" href="/signup">Create an account</Link>.</>
        ) : (
          <>Already have one? <Link className="text-accent underline" href="/login">Sign in</Link>.</>
        )}
      </p>

      <form action={action} className="mt-6 space-y-3">
        {next && <input type="hidden" name="next" value={next} />}
        {mode === "signup" && (
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input name="name" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2" autoComplete="name" />
          </label>
        )}
        <label className="block text-sm">
          <span className="text-muted">Email</span>
          <input name="email" type="email" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2" autoComplete="email" />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Password</span>
          <input name="password" type="password" required minLength={8} className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2" autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state?.message && <p className="text-sm text-accent">{state.message}</p>}
        <button disabled={pending} className="w-full rounded-md bg-accent px-3 py-2 font-medium text-accent-fg disabled:opacity-60">
          {pending ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>

      <form action={linkAction} className="space-y-3">
        <label className="block text-sm">
          <span className="text-muted">Email me a sign-in link</span>
          <input name="email" type="email" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2" autoComplete="email" />
        </label>
        {linkState?.error && <p className="text-sm text-red-600">{linkState.error}</p>}
        {linkState?.message && <p className="text-sm text-accent">{linkState.message}</p>}
        <button disabled={linkPending} className="w-full rounded-md border border-line px-3 py-2 font-medium disabled:opacity-60">
          {linkPending ? "Sending…" : "Send magic link"}
        </button>
      </form>
    </div>
  );
}
