import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_MAX_CHARS = 40_000;

const ALLOWED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
]);

export function isAllowedMime(mime: string) {
  return ALLOWED.has(mime);
}

/** Plain text from a PDF, DOCX, TXT or MD upload. Throws with a user-readable message. */
export async function extractResumeText(buffer: Buffer, mime: string, filename: string): Promise<string> {
  let text = "";
  const lower = filename.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const r = await parser.getText();
      text = r.text ?? "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else if (mime.includes("wordprocessingml") || lower.endsWith(".docx")) {
    const r = await mammoth.extractRawText({ buffer });
    text = r.value ?? "";
  } else {
    text = buffer.toString("utf8");
  }
  text = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 40) {
    throw new Error("Could not read any text from that file. If it is a scanned PDF, paste the text instead.");
  }
  return text.length > RESUME_MAX_CHARS ? text.slice(0, RESUME_MAX_CHARS) : text;
}
