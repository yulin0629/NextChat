/**
 * @jest-environment node
 */
// Bypass matrix from the security review of the server key fix. Only the
// "normal:" rows may receive the system key, and only on BASE_URL.
import { NextRequest } from "next/server";
import { canUseServerKey, handle } from "../app/api/proxy";

const KEY = "sk-review-canary-0000";
const HOST = "sub2api.yician0629.com";
type Row = { name: string; xbase: string[]; path: string[]; auth?: string };
const rows: Row[] = [
  // URL encoding
  {
    name: "pct-encoded dot in host",
    xbase: ["https://sub2api%2Eyician0629.com"],
    path: ["v1", "x"],
  },
  {
    name: "pct-encoded @ (evil%40host)",
    xbase: ["https://evil.com%40sub2api.yician0629.com"],
    path: ["v1"],
  },
  {
    name: "pct-encoded # in userinfo",
    xbase: ["https://evil.com%23@sub2api.yician0629.com"],
    path: ["v1"],
  },
  {
    name: "pct-encoded slash host",
    xbase: ["https://sub2api.yician0629.com%2F.evil.com"],
    path: ["v1"],
  },
  {
    name: "unicode fullwidth dot",
    xbase: ["https://sub2api．yician0629．com"],
    path: ["v1"],
  },
  // backslash
  {
    name: "backslash before @",
    xbase: ["https://evil.com\\@sub2api.yician0629.com"],
    path: ["v1"],
  },
  {
    name: "backslash after host",
    xbase: ["https://sub2api.yician0629.com\\@evil.com"],
    path: ["v1"],
  },
  { name: "https:\\\\evil", xbase: ["https:\\\\evil.com"], path: ["v1"] },
  // multiple @
  {
    name: "a@b@host",
    xbase: ["https://a@b@sub2api.yician0629.com"],
    path: ["v1"],
  },
  {
    name: "host@evil@host",
    xbase: ["https://sub2api.yician0629.com@evil.com@sub2api.yician0629.com"],
    path: ["v1"],
  },
  // scheme mix
  {
    name: "http downgrade",
    xbase: ["http://sub2api.yician0629.com"],
    path: ["v1"],
  },
  {
    name: "http with :443",
    xbase: ["http://sub2api.yician0629.com:443"],
    path: ["v1"],
  },
  {
    name: "HTTPS upper",
    xbase: ["HTTPS://SUB2API.YICIAN0629.COM"],
    path: ["v1"],
  },
  { name: "ws scheme", xbase: ["wss://sub2api.yician0629.com"], path: ["v1"] },
  // port
  {
    name: "explicit :443",
    xbase: ["https://sub2api.yician0629.com:443"],
    path: ["v1"],
  },
  {
    name: "port 0443",
    xbase: ["https://sub2api.yician0629.com:0443"],
    path: ["v1"],
  },
  {
    name: "port 8443",
    xbase: ["https://sub2api.yician0629.com:8443"],
    path: ["v1"],
  },
  // path traversal
  {
    name: "x-base-url path traversal",
    xbase: ["https://sub2api.yician0629.com/../../evil.com"],
    path: ["v1"],
  },
  {
    name: "subpath //evil",
    xbase: ["https://sub2api.yician0629.com"],
    path: ["", "evil.com", "v1"],
  },
  {
    name: "scheme-only base + host in subpath",
    xbase: ["https:"],
    path: ["", "evil.com"],
  },
  {
    name: "scheme-only base + server host in subpath",
    xbase: ["https:"],
    path: ["", HOST, "v1", "models"],
  },
  {
    name: "ingress /ops path on server host",
    xbase: ["https://sub2api.yician0629.com/ops"],
    path: ["x"],
  },
  // whitespace / control
  {
    name: "tab in host",
    xbase: ["https://sub2api.yician0629.com\t.evil.com"],
    path: ["v1"],
  },
  { name: "leading space", xbase: [" https://evil.com"], path: ["v1"] },
  {
    name: "trailing dot",
    xbase: ["https://sub2api.yician0629.com."],
    path: ["v1"],
  },
  {
    name: "suffix domain",
    xbase: ["https://sub2api.yician0629.com.evil.com"],
    path: ["v1"],
  },
  {
    name: "query smuggle",
    xbase: ["https://evil.com?sub2api.yician0629.com"],
    path: ["v1"],
  },
  // multi header
  {
    name: "two x-base-url (server first)",
    xbase: ["https://sub2api.yician0629.com", "https://evil.com"],
    path: ["v1"],
  },
  {
    name: "two x-base-url (evil first)",
    xbase: ["https://evil.com", "https://sub2api.yician0629.com"],
    path: ["v1"],
  },
  // normal
  {
    name: "normal: BASE_URL host",
    xbase: ["https://sub2api.yician0629.com"],
    path: ["v1", "images", "generations"],
  },
  {
    name: "normal: BASE_URL + /v1",
    xbase: ["https://sub2api.yician0629.com/v1"],
    path: ["images", "generations"],
  },
  {
    name: "dalle3 default api.openai.com",
    xbase: ["https://api.openai.com"],
    path: ["v1", "images", "generations"],
  },
  // access code forwarding
  {
    name: "lowercase bearer nk- to evil",
    xbase: ["https://evil.com"],
    path: ["v1"],
    auth: "bearer nk-secret",
  },
  {
    name: "Bearer nk- to evil",
    xbase: ["https://evil.com"],
    path: ["v1"],
    auth: "Bearer nk-secret",
  },
];

const INJECT = new Set(["normal: BASE_URL host", "normal: BASE_URL + /v1"]);

describe("review bypass matrix", () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY = KEY;
    process.env.BASE_URL = "https://sub2api.yician0629.com";
    delete process.env.CODE;
  });
  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BASE_URL;
  });

  test.each(rows)("$name", async (r) => {
    let seen: { url: string; auth: string | null } | null = null;
    global.fetch = jest.fn(async (url: any, init: any) => {
      seen = {
        url: String(url),
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response("ok");
    }) as any;
    const h = new Headers();
    try {
      for (const v of r.xbase) h.append("X-Base-Url", v);
    } catch {
      // not a valid header value, so it can never reach the proxy;
      // still check the url itself is not treated as the upstream
      for (const v of r.xbase) {
        expect(
          canUseServerKey(
            `${v}/${r.path.join("/")}`,
            "POST",
            process.env.BASE_URL,
          ),
        ).toBe(false);
      }
      return;
    }
    if (r.auth) h.set("Authorization", r.auth);
    const req = new NextRequest(
      "https://chat.example.com/api/proxy/" + r.path.join("/"),
      { method: "POST", headers: h, body: "{}" },
    );
    await handle(req, { params: { path: r.path } }).catch(() => undefined);
    const s = seen as { url: string; auth: string | null } | null;
    const injected = !!s && (s.auth ?? "").includes(KEY);
    expect(injected).toBe(INJECT.has(r.name));
    if (injected) {
      const u = new URL(s!.url);
      expect(u.protocol).toBe("https:");
      expect(u.host).toBe(HOST);
      expect(u.pathname).toBe("/v1/images/generations");
    }
    if (r.auth && s) {
      expect(s.auth).toBeNull();
    }
  });
});
