import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="flex flex-1 flex-col px-6 py-10">
      <Link href="/" className="mb-10 text-sm font-semibold">Jobs AI</Link>
      {sp.error === "link" && <p className="mx-auto mb-4 w-full max-w-sm text-sm text-red-600">That sign-in link is invalid or expired. Request a new one.</p>}
      <AuthForm mode="login" next={sp.next} />
    </main>
  );
}
