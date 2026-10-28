import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const MAX_URL_CHARS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const TIMEOUT_MS = 15 * 1000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// debt: ceiling: regex tag stripping, no layout or JS rendering; upgrade: a real
// HTML parser if pages come back as menus or empty text.
export function htmlToText(html: string) {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  ).trim();
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi,
        " ",
      )
      .replace(
        /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  return { title, text };
}

async function readCapped(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) return "";
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
  return new TextDecoder().decode(all);
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
    const isHtml = /html|xml/i.test(type);
    if (!isHtml && !/^text\/|json/i.test(type)) {
      return NextResponse.json(
        { error: `unsupported content type: ${type || "unknown"}` },
        { status: 415 },
      );
    }
    const body = await readCapped(res);
    const { title, text } = isHtml
      ? htmlToText(body)
      : { title: "", text: body.trim() };
    return NextResponse.json({
      url: res.url || target.toString(),
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    });
  } catch (e) {
    console.error("[Fetch] request failed", e);
    return NextResponse.json({ error: "page request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
