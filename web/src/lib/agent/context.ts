import type { SupabaseClient } from "@supabase/supabase-js";

export type Profile = {
  name: string;
  notes: string | null;
  preferences: Record<string, unknown>;
  interview_insights: string | null;
};

export const RESUME_CONTEXT_CHARS = 12_000;

export async function loadProfile(supabase: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("user_profiles")
    .select("name, notes, preferences, interview_insights")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

export async function loadCurrentResume(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("resumes")
    .select("id, filename, text, created_at")
    .eq("user_id", userId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string; filename: string; text: string; created_at: string } | null;
}

/**
 * The per-person context the model reads. Goes into the first user turn of a conversation and,
 * when it changes later, is appended as a mid-conversation system message. Never edited in place.
 */
export function buildCandidateContext(opts: {
  profile: Profile | null;
  resume: { filename: string; text: string } | null;
  mode: "chat" | "interview";
  today: string;
}): string {
  const { profile, resume, mode, today } = opts;
  const parts: string[] = [];
  parts.push(`<candidate_context>`);
  parts.push(`Today: ${today}`);
  parts.push(`Interview mode: ${mode === "interview" ? "ON" : "OFF"}`);
  if (profile) {
    if (profile.name) parts.push(`Name: ${profile.name}`);
    if (profile.notes) parts.push(`Notes from the person: ${profile.notes}`);
    if (profile.preferences && Object.keys(profile.preferences).length > 0) {
      parts.push(`Saved preferences (JSON): ${JSON.stringify(profile.preferences)}`);
    }
    if (profile.interview_insights) parts.push(`Interview insights: ${profile.interview_insights}`);
  } else {
    parts.push(`No saved profile yet.`);
  }
  if (resume) {
    const text = resume.text.length > RESUME_CONTEXT_CHARS
      ? resume.text.slice(0, RESUME_CONTEXT_CHARS) + "\n[resume truncated]"
      : resume.text;
    parts.push(`<resume filename="${resume.filename.replace(/"/g, "'")}">\n${text}\n</resume>`);
  } else {
    parts.push(`No resume uploaded. Work from what the person tells you; suggest uploading one on the Profile page when it would help.`);
  }
  parts.push(`</candidate_context>`);
  return parts.join("\n");
}

/** Small stable hash so we can tell when the context changed between turns. */
export function hashContext(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}
