/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { POST } from "../app/api/search/route";

const KEY = "test-exa-key-123";

function post(body: unknown, raw = false) {
  return new NextRequest("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("POST /api/search", () => {
  const realFetch = global.fetch;
  const realKey = process.env.EXA_API_KEY;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.EXA_API_KEY = KEY;
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = realKey;
    jest.restoreAllMocks();
  });

  test("503 without a key, and never calls the provider", async () => {
    delete process.env.EXA_API_KEY;
    const res = await POST(post({ query: "x" }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["missing query", {}],
    ["blank query", { query: "   " }],
    ["non-string query", { query: 42 }],
    ["oversized query", { query: "a".repeat(501) }],
  ])("400 for %s", async (_name, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("400 for a body that is not json", async () => {
    const res = await POST(post("not json", true));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends a lite search to Exa and returns trimmed results", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: Array.from({ length: 7 }, (_, i) => ({
            title: `t${i}`,
            url: `https://example.com/${i}`,
            publishedDate: "2026-10-01",
            highlights: ["a".repeat(1000), "b".repeat(1000)],
            text: "dropped",
            id: "dropped",
          })),
        }),
        { status: 200 },
      ),
    );

    const res = await POST(post({ query: "  latest nextchat release  " }));
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({
      query: "latest nextchat release",
      type: "lite",
      numResults: 5,
      contents: { highlights: true },
    });

    const data = await res.json();
    expect(data.results).toHaveLength(5);
    expect(Object.keys(data.results[0]).sort()).toEqual([
      "excerpt",
      "publishedDate",
      "title",
      "url",
    ]);
    expect(data.results[0].excerpt.length).toBe(1200);
    expect(JSON.stringify(data)).not.toContain(KEY);
  });

  test("tolerates results without highlights", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ results: [{ url: "https://e.com" }] }), {
        status: 200,
      }),
    );
    const data = await (await POST(post({ query: "q" }))).json();
    expect(data.results).toEqual([
      { title: "", url: "https://e.com", excerpt: "" },
    ]);
  });

  test("502 with only the status when Exa rejects, never its body or the key", async () => {
    fetchMock.mockResolvedValue(
      new Response(`invalid key ${KEY}`, { status: 401 }),
    );
    const res = await POST(post({ query: "q" }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("401");
    expect(text).not.toContain(KEY);
  });

  test("502 when the provider cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error(`boom ${KEY}`));
    const res = await POST(post({ query: "q" }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(KEY);
  });
});
