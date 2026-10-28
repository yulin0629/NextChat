import { NextRequest, NextResponse } from "next/server";
import { htmlToText } from "@/app/utils/html-to-text";

export const runtime = "edge";

const MAX_URL_CHARS = 2000;
// large enough for pages whose <title> comes late (YouTube: ~800 KB in); text
// extraction is one linear pass, a few ms per MB
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const TIMEOUT_MS = 15 * 1000;

// The meta charset of an HTML page, from its first 2 KB (attributes parsed, so a
// "charset=" inside another attribute's value is not taken).
function metaCharset(head: Uint8Array) {
  // the meta tag is ASCII, so a utf-8 read of the first bytes finds it
  const text = new TextDecoder().decode(head.subarray(0, 2048));
  for (const tag of text.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const a of tag.matchAll(
      /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4];
    }
    const label =
      attrs.charset ??
      (attrs["http-equiv"]?.toLowerCase() === "content-type"
        ? attrs.content?.match(/charset=\s*["']?([\w-]+)/i)?.[1]
        : undefined);
    // a page readable enough to find its meta tag is not utf-16 (WHATWG prescan rule)
    if (label) return /^utf-16/i.test(label) ? "utf-8" : label;
  }
}

// Byte order mark first, then the header, then (HTML only) the meta tag; utf-8 when unknown.
function pageDecoder(type: string, body: Uint8Array, isHtml: boolean) {
  const bom =
    body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
      ? "utf-8"
      : body[0] === 0xff && body[1] === 0xfe
      ? "utf-16le"
      : body[0] === 0xfe && body[1] === 0xff
      ? "utf-16be"
      : undefined;
  const label =
    bom ??
    type.match(/charset=\s*["']?([\w-]+)/i)?.[1] ??
    (isHtml ? metaCharset(body) : undefined);
  try {
    return new TextDecoder(label || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

async function readCapped(res: Response, type: string, isHtml: boolean) {
  const reader = res.body?.getReader();
  if (!reader) return { body: "", capped: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - offset);
    all.set(part, offset);
    offset += part.length;
    if (offset >= all.length) break;
  }
  return {
    body: pageDecoder(type, all, isHtml).decode(all),
    capped: size >= MAX_BODY_BYTES,
  };
}

// Backs the Web Search tool's fetch_url: reads one public page straight from
// the edge and returns plain text, so reading a page costs nothing.
export async function POST(req: NextRequest) {
  let target: URL | undefined;
  try {
    const body = await req.json();
    const raw = typeof body?.url === "string" ? body.url.trim() : "";
    if (raw && raw.length <= MAX_URL_CHARS) target = new URL(raw);
  } catch {}
  if (!target || !["http:", "https:"].includes(target.protocol)) {
    return NextResponse.json(
      { error: "url is required: an http or https address" },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "Mozilla/5.0 (compatible; NextChat fetch_url)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `page returned ${res.status}` },
        { status: 502 },
      );
    }
    const type = res.headers.get("content-type") ?? "";
    // not /xml/ alone: Office files are "application/vnd.openxmlformats-…"
    const isHtml =
      /^\s*(text\/html|text\/xml|application\/(xhtml\+|[\w.-]+\+)?xml)\s*(;|$)/i.test(
        type,
      );
    if (!isHtml && !/^text\/|json/i.test(type)) {
      return NextResponse.json(
        { error: `unsupported content type: ${type || "unknown"}` },
        { status: 415 },
      );
    }
    const { body, capped } = await readCapped(res, type, isHtml);
    const { title, text } = isHtml
      ? htmlToText(body)
      : { title: "", text: body.trim() };
    return NextResponse.json({
      url: res.url || target.toString(),
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: capped || text.length > MAX_TEXT_CHARS,
    });
  } catch (e) {
    console.error("[Fetch] request failed", e);
    return NextResponse.json({ error: "page request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
