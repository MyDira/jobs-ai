"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function createConversation(mode: "chat" | "interview" = "chat") {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: user.id, mode })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create conversation");
  redirect(`/app/c/${data.id}`);
}

export async function setConversationMode(conversationId: string, mode: "chat" | "interview") {
  const { supabase } = await requireUser();
  await supabase.from("conversations").update({ mode, updated_at: new Date().toISOString() }).eq("id", conversationId);
  revalidatePath(`/app/c/${conversationId}`);
}

export async function deleteConversation(conversationId: string) {
  const { supabase } = await requireUser();
  await supabase.from("conversations").delete().eq("id", conversationId);
  revalidatePath("/app");
  redirect("/app");
}

export async function saveProfile(formData: FormData) {
  const { supabase, user } = await requireUser();
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 3000) || null;
  const { data: existing } = await supabase.from("user_profiles").select("id").eq("user_id", user.id).maybeSingle();
  if (existing) {
    await supabase.from("user_profiles").update({ name, notes, updated_at: new Date().toISOString() }).eq("user_id", user.id);
  } else {
    await supabase.from("user_profiles").insert({ user_id: user.id, name, notes });
  }
  revalidatePath("/app/profile");
}

export async function clearPreferences() {
  const { supabase, user } = await requireUser();
  await supabase
    .from("user_profiles")
    .update({ preferences: {}, interview_insights: null, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);
  revalidatePath("/app/profile");
}

export async function removeResume(resumeId: string) {
  const { supabase, user } = await requireUser();
  await supabase.from("resumes").delete().eq("id", resumeId).eq("user_id", user.id);
  revalidatePath("/app/profile");
}
