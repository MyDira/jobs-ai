import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Opens the newest conversation, or creates the first one. */
export default async function AppIndex() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: latest } = await supabase
    .from("conversations")
    .select("id")
    .eq("archived", false)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest) redirect(`/app/c/${latest.id}`);

  const { data: created, error } = await supabase.from("conversations").insert({ user_id: user.id }).select("id").single();
  if (error || !created) throw new Error(error?.message ?? "Could not create a conversation");
  redirect(`/app/c/${created.id}`);
}
