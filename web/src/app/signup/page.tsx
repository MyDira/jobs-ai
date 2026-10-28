import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default function SignupPage() {
  return (
    <main className="flex flex-1 flex-col px-6 py-10">
      <Link href="/" className="mb-10 text-sm font-semibold">Jobs AI</Link>
      <AuthForm mode="signup" />
    </main>
  );
}
