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

describe("POST /api/fetch charset choice", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const enc = (t: string) => new TextEncoder().encode(t);
  async function textOf(type: string, bytes: Uint8Array) {
    global.fetch = jest.fn(
      async () =>
        new Response(bytes, { status: 200, headers: { "content-type": type } }),
    ) as any;
    return (await (await POST(post({ url: "https://example.com/" }))).json())
      .text;
  }

  test("a meta tag that claims utf-16 is read as utf-8", async () => {
    expect(
      await textOf("text/html", enc('<meta charset="utf-16"><p>Hello wörld 中文</p>')),
    ).toBe("Hello wörld 中文");
  });

  test("plain text is never sniffed for meta tags", async () => {
    const t = 'Example: <meta charset="big5"> is how 中文 pages say it';
    expect(await textOf("text/plain", enc(t))).toBe(t);
  });

  test("charset= inside another attribute's value is ignored", async () => {
    expect(
      await textOf(
        "text/html",
        enc('<meta name="description" content="set charset=big5 for legacy"><meta charset="utf-8"><p>中文</p>'),
      ),
    ).toBe("中文");
  });

  test("http-equiv content-type still works", async () => {
    expect(
      await textOf(
        "text/html",
        new Uint8Array([
          ...enc('<meta http-equiv="Content-Type" content="text/html; charset=big5">'),
          0xa4, 0xa4, 0xa4, 0xe5,
        ]),
      ),
    ).toBe("中文");
  });

  test("a byte order mark wins over the header", async () => {
    expect(
      await textOf(
        "text/html; charset=iso-8859-1",
        new Uint8Array([0xef, 0xbb, 0xbf, ...enc("<p>中文</p>")]),
      ),
    ).toBe("中文");
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

  test.each([
    ["unclosed comments", "<!--a".repeat(50000)],
    ["unclosed svgs", "<svg a".repeat(50000)],
    ["titles without >", "<title a".repeat(50000)],
  ])("stays fast on a page full of %s (no > at all)", (_, html) => {
    const start = Date.now();
    htmlToText(html);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("keeps positions right after characters that grow when lowercased", () => {
    const html =
      "<head><title>İstanbul</title></head><p>İİİİİİİİİİ</p><script>SECRETJSCODE</script><p>visible text here</p>";
    expect(htmlToText(html)).toEqual({
      title: "İstanbul",
      text: "İİİİİİİİİİ\nvisible text here",
    });
  });

  test("strips a tag that is missing its > the way browsers read it", () => {
    // cna.com.tw menu markup
    expect(
      htmlToText(
        "<li><a class='menuUrl' href='/list/aipl.aspx' <span class='_ellipsis'>政治</span></a></li>",
      ).text,
    ).toBe("政治");
    expect(htmlToText('<a title="x<y" href="/">link text</a>').text).toBe(
      "link text",
    );
  });

  test.each([
    ["no </head>", "<head><title>T</title><body><p>body text</p>", "T body text"],
    ["self-closing svg", '<p>before</p><svg width="0"/><p>after svg</p>', "before\nafter svg"],
    ["empty comment <!-->", "<p>one</p><!--><p>two</p><!-- c --><p>three</p>", "one\ntwo\nthree"],
    ["end-tag look-alike", "<p>x</p><script>a='</scripty>'; b=1</script><p>y</p>", "x\ny"],
    ["custom element named like a block", "<svg-icon>icon</svg-icon><p>text</p><svg><path/></svg>", "icon text"],
    ["end tag with spaces", "<script>a</script  ><p>z</p>", "z"],
  ])("keeps the page's text: %s", (_, html, text) => {
    expect(htmlToText(html).text).toBe(text);
  });

  test("drops comments and keeps paragraph breaks", () => {
    expect(htmlToText("<div>one<!-- hidden --></div><div>two</div>").text).toBe(
      "one\ntwo",
    );
  });
});
