import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadCurrentResume, loadProfile } from "@/lib/agent/context";
import { clearPreferences, removeResume, saveProfile } from "@/app/app/actions";
import { ResumeUploader } from "@/components/ResumeUploader";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const [profile, resume] = await Promise.all([loadProfile(supabase, user.id), loadCurrentResume(supabase, user.id)]);
  const prefs = profile?.preferences ?? {};
  const hasPrefs = Object.keys(prefs).length > 0 || Boolean(profile?.interview_insights);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
      <p className="mt-1 text-sm text-muted">The agent reads this at the start of every conversation. Changes apply to the next message you send.</p>

      <section className="mt-8 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-medium">Resume</h2>
        {resume ? (
          <div className="mt-2 text-sm">
            <p>
              <span className="font-medium">{resume.filename}</span>
              <span className="text-muted"> · uploaded {new Date(resume.created_at).toLocaleDateString()} · {resume.text.length.toLocaleString()} characters</span>
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-muted">Show extracted text</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-soft p-3 font-mono text-xs">{resume.text}</pre>
            </details>
            <form action={removeResume.bind(null, resume.id)} className="mt-3">
              <button className="text-xs text-red-600 underline">Remove this resume</button>
            </form>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No resume yet. Upload one so the agent can judge fit, not just keywords.</p>
        )}
        <div className="mt-4">
          <ResumeUploader replace={Boolean(resume)} />
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-medium">About you</h2>
        <form action={saveProfile} className="mt-3 space-y-3 text-sm">
          <label className="block">
            <span className="text-muted">Name</span>
            <input name="name" defaultValue={profile?.name ?? ""} className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-muted">Anything the agent should always know</span>
            <textarea
              name="notes"
              rows={4}
              defaultValue={profile?.notes ?? ""}
              placeholder="e.g. I live in Lakewood, no car, available mornings until 2, need at least $25/hr, fluent Yiddish, cannot do sales."
              className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2"
            />
          </label>
          <button className="rounded-md bg-accent px-4 py-2 font-medium text-accent-fg">Save</button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-panel p-5">
        <h2 className="font-medium">What the agent has learned</h2>
        <p className="mt-1 text-sm text-muted">Saved by the agent from your conversations and interviews.</p>
        {hasPrefs ? (
          <>
            {profile?.interview_insights && <p className="mt-3 whitespace-pre-wrap text-sm">{profile.interview_insights}</p>}
            {Object.keys(prefs).length > 0 && (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {Object.entries(prefs).map(([k, v]) => (
                  <div key={k} className="rounded bg-soft p-2">
                    <dt className="text-xs uppercase tracking-wide text-muted">{k.replace(/_/g, " ")}</dt>
                    <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <form action={clearPreferences} className="mt-4">
              <button className="text-xs text-red-600 underline">Clear everything the agent learned</button>
            </form>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">Nothing yet.</p>
        )}
      </section>
    </main>
  );
}
