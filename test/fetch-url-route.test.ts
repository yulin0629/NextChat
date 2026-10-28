/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { POST } from "../app/api/fetch/route";
import { htmlToText } from "../app/utils/html-to-text";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function page(body: string, type = "text/html; charset=utf-8", status = 200) {
  return new Response(body, { status, headers: { "content-type": type } });
}

describe("POST /api/fetch", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  test.each([[{}], [{ url: "" }], [{ url: "file:///etc/passwd" }], [{ url: "not a url" }]])(
    "400 for %j and never fetches",
    async (body) => {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("returns the page title and readable text, without scripts or styles", async () => {
    fetchMock.mockResolvedValue(
      page(
        "<html><head><title>Rain &amp; Wind</title><style>p{color:red}</style></head>" +
          "<body><script>var secret=1</script><h1>Taipei</h1><p>Rain&nbsp;today.</p><p>25&#176;C</p></body></html>",
      ),
    );
    const res = await POST(post({ url: "https://example.com/weather" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/weather");
    expect(data.title).toBe("Rain & Wind");
    expect(data.text).toBe("Taipei\nRain today.\n25°C");
    expect(data.truncated).toBe(false);
  });

  test("passes plain text through and caps long pages", async () => {
    fetchMock.mockResolvedValue(page("a".repeat(13000), "text/plain"));
    const data = await (await POST(post({ url: "https://example.com/a.txt" }))).json();
    expect(data.text).toHaveLength(12000);
    expect(data.truncated).toBe(true);
  });

  test("415 for binary content such as a PDF", async () => {
    fetchMock.mockResolvedValue(page("%PDF-1.7", "application/pdf"));
    const res = await POST(post({ url: "https://example.com/a.pdf" }));
    expect(res.status).toBe(415);
  });

  test("502 when the page answers with an error or the request fails", async () => {
    fetchMock.mockResolvedValueOnce(page("gone", "text/html", 404));
    expect((await POST(post({ url: "https://example.com/x" }))).status).toBe(502);
    fetchMock.mockRejectedValueOnce(new Error("dns"));
    expect((await POST(post({ url: "https://example.com/y" }))).status).toBe(502);
  });
});

describe("POST /api/fetch charset", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // "<p>中文</p>" in Big5: 中 = A4 A4, 文 = A4 E5
  const big5 = new Uint8Array([
    0x3c, 0x70, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5, 0x3c, 0x2f, 0x70, 0x3e,
  ]);

  test.each([
    ["the header", "text/html; charset=big5", big5],
    [
      "a meta tag",
      "text/html",
      new Uint8Array([
        ...new TextEncoder().encode('<meta charset="big5">'),
        ...big5,
      ]),
    ],
  ])("decodes a Big5 page named in %s", async (_, type, bytes) => {
    global.fetch = jest.fn(
      async () =>
        new Response(bytes, { status: 200, headers: { "content-type": type } }),
    ) as any;
    const data = await (
      await POST(post({ url: "https://example.com.tw/" }))
    ).json();
    expect(data.text).toBe("中文");
  });
});

describe("htmlToText", () => {
  test.each([
    ["unclosed comments", "<!--a".repeat(50000)],
    ["unclosed scripts", "<script x>a".repeat(20000)],
    ["unclosed titles", "<title>a".repeat(50000)],
    ["stray angle brackets", "a < b ".repeat(100000)],
  ])("stays fast on a page full of %s", (_, html) => {
    const start = Date.now();
    htmlToText(html);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("an unclosed script hides everything after it", () => {
    expect(htmlToText("<p>keep</p><script>var x = 1").text).toBe("keep");
  });

  test("drops comments and keeps paragraph breaks", () => {
    expect(htmlToText("<div>one<!-- hidden --></div><div>two</div>").text).toBe(
      "one\ntwo",
    );
  });
});
