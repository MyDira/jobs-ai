import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBalance } from "@/lib/credits";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: conversations }, balance] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, mode, updated_at")
      .eq("archived", false)
      .order("updated_at", { ascending: false })
      .limit(50),
    getBalance(user.id),
  ]);

  return (
    <div className="flex min-h-screen">
      <Sidebar conversations={conversations ?? []} balanceMicros={balance} email={user.email ?? ""} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
