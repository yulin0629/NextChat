import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const MAX_QUERY_CHARS = 500;
const MAX_EXCERPT_CHARS = 1200;
const RESULT_COUNT = 5;
const TIMEOUT_MS = 20 * 1000;

// Backs the built-in Web Search tool (app/store/plugin.ts). The Exa key stays
// on the server; the browser only sees titles, urls and short excerpts.
export async function POST(req: NextRequest) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "web search is not configured" },
      { status: 503 },
    );
  }

  let query = "";
  try {
    const body = await req.json();
    query = typeof body?.query === "string" ? body.query.trim() : "";
  } catch {}
  if (!query || query.length > MAX_QUERY_CHARS) {
    return NextResponse.json(
      { error: `query is required, up to ${MAX_QUERY_CHARS} characters` },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        type: "lite",
        numResults: RESULT_COUNT,
        contents: { highlights: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[Search] upstream status", res.status);
      return NextResponse.json(
        { error: `search provider returned ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const results = (Array.isArray(data?.results) ? data.results : [])
      .slice(0, RESULT_COUNT)
      .map((r: any) => ({
        title: r?.title ?? "",
        url: r?.url ?? "",
        publishedDate: r?.publishedDate ?? undefined,
        excerpt: (Array.isArray(r?.highlights) ? r.highlights : [])
          .join(" ... ")
          .slice(0, MAX_EXCERPT_CHARS),
      }));
    return NextResponse.json({ results });
  } catch (e) {
    console.error("[Search] request failed", e);
    return NextResponse.json(
      { error: "search request failed" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
