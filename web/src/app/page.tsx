import Link from "next/link";
import { getUser } from "@/lib/supabase/server";

export default async function Home() {
  const user = await getUser();
  return (
    <main className="flex-1">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-lg font-semibold tracking-tight">Jobs AI</span>
        <nav className="flex items-center gap-3 text-sm">
          {user ? (
            <Link href="/app" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Open the app</Link>
          ) : (
            <>
              <Link href="/login" className="px-3 py-1.5 text-muted hover:text-fg">Sign in</Link>
              <Link href="/signup" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Create account</Link>
            </>
          )}
        </nav>
      </header>
      <section className="mx-auto max-w-3xl px-6 pb-20 pt-16">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Every job in this week&apos;s papers and job sites, sorted for you.
        </h1>
        <p className="mt-6 text-lg text-muted">
          Upload your resume, say where you want to work and what hours, and an AI recruiter searches about 1,600 live
          listings from BP Weekly, The Voice of Lakewood, the Boro Park View, the Weekly Link, FJJ, Torah Times, MacherUSA,
          YidJob, JewishJobs, luach.com and the Jewish Press. You get a ranked shortlist: the perfect fits, the strong ones,
          the stretches worth a look, and what pays the bills meanwhile.
        </p>
        <ul className="mt-8 grid gap-4 text-sm sm:grid-cols-3">
          <li className="rounded-lg border border-line bg-panel p-4"><strong className="block">Talk to it like a person.</strong><span className="text-muted">Ask follow-ups, narrow by town or hours, say what you would never do.</span></li>
          <li className="rounded-lg border border-line bg-panel p-4"><strong className="block">Optional interview.</strong><span className="text-muted">Let it ask you ten questions first; it often finds directions you had not considered.</span></li>
          <li className="rounded-lg border border-line bg-panel p-4"><strong className="block">Pay as you go.</strong><span className="text-muted">Credits from $5. Every answer shows exactly what it cost. No subscription.</span></li>
        </ul>
        <div className="mt-10 flex gap-3">
          <Link href={user ? "/app" : "/signup"} className="rounded-md bg-accent px-5 py-2.5 font-medium text-accent-fg">
            {user ? "Open the app" : "Get started"}
          </Link>
          {!user && <Link href="/login" className="rounded-md border border-line px-5 py-2.5 font-medium">Sign in</Link>}
        </div>
      </section>
    </main>
  );
}
