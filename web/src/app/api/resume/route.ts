import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { extractResumeText, isAllowedMime, RESUME_MAX_BYTES, RESUME_MAX_CHARS } from "@/lib/resume/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST multipart/form-data with `file`, or JSON { text, filename } for pasted text.
 * Stores the file privately, extracts the text, makes it the current resume.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let text = "";
  let filename = "pasted-resume.txt";
  let mime = "text/plain";
  let bytes = 0;
  let storagePath: string | null = null;

  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
      if (file.size > RESUME_MAX_BYTES) return NextResponse.json({ error: "File larger than 10 MB" }, { status: 400 });
      mime = file.type || "application/octet-stream";
      filename = file.name || "resume";
      if (!isAllowedMime(mime) && !/\.(pdf|docx|txt|md)$/i.test(filename)) {
        return NextResponse.json({ error: "Upload a PDF, DOCX, TXT or MD file" }, { status: 400 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      bytes = buf.length;
      text = await extractResumeText(buf, mime, filename);

      const svc = createServiceClient();
      const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 80);
      storagePath = `${user.id}/${Date.now()}-${safeName}`;
      const { error: upErr } = await svc.storage.from("resumes").upload(storagePath, buf, { contentType: mime, upsert: false });
      if (upErr) storagePath = null; // the text is what matters; keep going
    } else {
      const body = (await req.json()) as { text?: string; filename?: string };
      text = (body.text ?? "").replace(/\r/g, "").trim();
      if (text.length < 40) return NextResponse.json({ error: "Paste at least a few lines" }, { status: 400 });
      if (text.length > RESUME_MAX_CHARS) text = text.slice(0, RESUME_MAX_CHARS);
      filename = (body.filename ?? filename).slice(0, 80);
      bytes = Buffer.byteLength(text);
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  await supabase.from("resumes").update({ is_current: false }).eq("user_id", user.id).eq("is_current", true);
  const { data, error } = await supabase
    .from("resumes")
    .insert({ user_id: user.id, storage_path: storagePath, filename, mime, bytes, text, is_current: true })
    .select("id, filename, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, resume: data, chars: text.length });
}
