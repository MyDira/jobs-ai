"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResumeUploader({ replace }: { replace: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<"file" | "paste">("file");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pasted, setPasted] = useState("");

  async function send(body: FormData | string, isJson: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/resume", {
        method: "POST",
        body,
        headers: isJson ? { "Content-Type": "application/json" } : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setMsg({ ok: true, text: `Saved ${data.resume.filename} (${data.chars.toLocaleString()} characters of text).` });
      setPasted("");
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm">
      <div className="flex gap-2 text-xs">
        <button onClick={() => setTab("file")} className={`rounded px-2 py-1 ${tab === "file" ? "bg-soft font-medium" : "text-muted"}`}>Upload a file</button>
        <button onClick={() => setTab("paste")} className={`rounded px-2 py-1 ${tab === "paste" ? "bg-soft font-medium" : "text-muted"}`}>Paste text</button>
      </div>
      {tab === "file" ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const f = fd.get("file");
            if (!(f instanceof File) || f.size === 0) return setMsg({ ok: false, text: "Choose a file first." });
            void send(fd, false);
          }}
        >
          <input name="file" type="file" accept=".pdf,.docx,.txt,.md,application/pdf" className="text-xs" />
          <button disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-60">
            {busy ? "Reading…" : replace ? "Replace resume" : "Upload"}
          </button>
          <span className="text-xs text-muted">PDF, Word (.docx) or text, up to 10 MB. Stored privately.</span>
        </form>
      ) : (
        <div className="mt-2">
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={8} placeholder="Paste your resume text here" className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs" />
          <button
            disabled={busy || pasted.trim().length < 40}
            onClick={() => void send(JSON.stringify({ text: pasted, filename: "pasted-resume.txt" }), true)}
            className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save pasted resume"}
          </button>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-accent" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}
