/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { canUseServerKey, handle, isServerUpstream } from "../app/api/proxy";

const BYPASSES = [
  "https://api.openai.com.evil.com",
  "https://evil.com/api.openai.com",
  "https://evil.com?q=api.openai.com",
  "https://evil.com#api.openai.com",
  "https://api.openai.com@evil.com",
  "https://user:pass@api.openai.com",
  "https://API.OPENAI.COM.evil.com",
  "https://api.openai.com.",
  "https://API.OPENAI.COM.",
  "http://api.openai.com",
  "https://api.openai.com:8443",
  "https://[::1]",
  "https://[::ffff:a29e:b3c4]",
  "https://162.159.140.245",
  "https://2728301765",
  "https://0xa29eb3c4",
  "https://evil-api.openai.com",
  "ftp://api.openai.com",
  "//api.openai.com",
  "api.openai.com",
  "",
  null,
];

describe("isServerUpstream without BASE_URL (api.openai.com)", () => {
  test.each(BYPASSES)("rejects %p", (target) => {
    expect(isServerUpstream(target, undefined)).toBe(false);
    expect(
      isServerUpstream(target === null ? null : `${target}/v1/x?a=1`),
    ).toBe(false);
  });

  test.each([
    "https://api.openai.com",
    "https://api.openai.com/v1",
    "https://api.openai.com:443",
    "https://API.OpenAI.com",
  ])("accepts %p", (target) => {
    expect(isServerUpstream(target)).toBe(true);
    expect(isServerUpstream(`${target}/v1/images/generations?`)).toBe(true);
  });
});

describe("isServerUpstream with BASE_URL", () => {
  const base = "https://sub2api.example.com";

  test.each([
    "https://api.openai.com",
    "http://sub2api.example.com",
    "https://sub2api.example.com.",
    "https://sub2api.example.com.evil.com",
    "https://evil.com/sub2api.example.com",
    "https://sub2api.example.com@evil.com",
    "https://sub2api.example.com:444",
  ])("rejects %p", (target) => {
    expect(isServerUpstream(target, base)).toBe(false);
  });

  test.each([
    "https://sub2api.example.com",
    "https://sub2api.example.com/v1",
    "https://SUB2API.example.com",
  ])("accepts %p", (target) => {
    expect(isServerUpstream(target, base)).toBe(true);
    expect(isServerUpstream(target, `${base}/v1/`)).toBe(true);
    expect(isServerUpstream(target, "sub2api.example.com")).toBe(true);
  });
});

describe("proxy handle only sends the system key to BASE_URL", () => {
  const KEY = "sk-test-canary-proxy";
  const CODE = "secret-code";
  let calls: { url: string; auth: string | null }[] = [];

  beforeEach(() => {
    calls = [];
    process.env.OPENAI_API_KEY = KEY;
    process.env.BASE_URL = "https://sub2api.example.com";
    delete process.env.CODE;
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return new Response("ok");
    }) as any;
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BASE_URL;
    delete process.env.CODE;
  });

  function call(baseUrl: string, auth?: string, proxyHandle = handle) {
    const headers: Record<string, string> = { "x-base-url": baseUrl };
    if (auth) headers["Authorization"] = auth;
    const req = new NextRequest(
      "https://chat.example.com/api/proxy/v1/images/generations",
      { method: "POST", headers, body: "{}" },
    );
    return proxyHandle(req, {
      params: { path: ["v1", "images", "generations"] },
    });
  }

  test.each([
    ...BYPASSES.filter((v): v is string => !!v),
    "https://api.openai.com",
  ])("does not leak the key to %p", async (target) => {
    await call(target).catch(() => undefined);
    for (const c of calls) {
      expect(c.auth ?? "").not.toContain(KEY);
    }
  });

  test("injects the key for BASE_URL", async () => {
    const res = await call("https://sub2api.example.com");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
  });

  test("requires the access code when CODE is set", async () => {
    // access codes are read once at module load
    process.env.CODE = CODE;
    let codeHandle = handle;
    jest.isolateModules(() => {
      codeHandle = require("../app/api/proxy").handle;
    });
    const denied = await call("https://sub2api.example.com", "", codeHandle);
    expect(denied.status).toBe(401);
    expect(calls).toHaveLength(0);

    const ok = await call(
      "https://sub2api.example.com",
      `Bearer nk-${CODE}`,
      codeHandle,
    );
    expect(ok.status).toBe(200);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
  });

  test("does not forward the access code to other hosts", async () => {
    await call("https://evil.com", `Bearer nk-${CODE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBeNull();
  });
});

describe("canUseServerKey only allows OpenAI paths and methods", () => {
  const base = "https://sub2api.example.com";

  test.each([
    [`${base}/v1/images/generations?`, "POST", base],
    [`${base}/v1/images/generations`, "post", base],
    [`${base}/v1/chat/completions`, "POST", base],
    [`${base}/v1/audio/speech`, "POST", base],
    [`${base}/v1/models`, "GET", base],
    [`${base}/dashboard/billing/usage?start_date=x`, "GET", base],
    [`${base}/dashboard/billing/subscription`, "GET", base],
    [`${base}/v1/images/generations`, "POST", `${base}/`],
    [`${base}/v1/images/generations`, "POST", "sub2api.example.com"],
    [`${base}/v1/live/../images/generations`, "POST", base],
    [`${base}/proxy/v1/images/generations`, "POST", `${base}/proxy`],
    ["https://api.openai.com/v1/images/generations", "POST", undefined],
  ])("accepts %p %p (BASE_URL=%p)", (target, method, baseUrl) => {
    expect(canUseServerKey(target, method, baseUrl)).toBe(true);
  });

  test.each([
    [`${base}`, "POST"],
    [`${base}/`, "POST"],
    [`${base}/ops`, "POST"],
    [`${base}/ops/x`, "GET"],
    [`${base}/v1/live`, "POST"],
    [`${base}/v1/live/ws`, "GET"],
    [`${base}/v1/images/../../ops`, "POST"],
    [`${base}/v1/images/%2e%2e/%2e%2e/ops`, "POST"],
    [`${base}/v1/images/%2E%2E/%2e%2E/ops`, "POST"],
    [`${base}/v1/images/.%2e/.%2E/ops`, "POST"],
    [`${base}/v1/images/generations/../../live`, "POST"],
    [`${base}/v1/images%2Fgenerations`, "POST"],
    [`${base}/v1/images%2fgenerations`, "POST"],
    [`${base}/v1/images/generations%2F..%2F..%2Fops`, "POST"],
    [`${base}/v1/%69mages/generations`, "POST"],
    [`${base}/v1/images/generations%00`, "POST"],
    [`${base}//v1/images/generations`, "POST"],
    [`${base}/v1//images/generations`, "POST"],
    [`${base}/v1/images/generations/`, "POST"],
    [`${base}/v1/images/generations/x`, "POST"],
    [`${base}/V1/images/generations`, "POST"],
    [`${base}/v1/images/generations;x`, "POST"],
    [`${base}/v1/images/generations`, "GET"],
    [`${base}/v1/images/generations`, "PUT"],
    [`${base}/v1/chat/completions`, "DELETE"],
    [`${base}/v1/models`, "POST"],
    [`${base}/v1/models/x`, "GET"],
    [`${base}/dashboard/billing/usage`, "POST"],
    [`${base}/v1/images/generations`, "HEAD"],
    ["https://evil.com/v1/images/generations", "POST"],
  ])("rejects %p %p", (target, method) => {
    expect(canUseServerKey(target, method, base)).toBe(false);
  });

  test("rejects paths outside the BASE_URL path prefix", () => {
    expect(
      canUseServerKey(`${base}/v1/images/generations`, "POST", `${base}/proxy`),
    ).toBe(false);
    expect(
      canUseServerKey(
        `${base}/proxy/../v1/images/generations`,
        "POST",
        `${base}/proxy`,
      ),
    ).toBe(false);
  });
});

describe("proxy handle path and method allowlist", () => {
  const KEY = "sk-test-canary-path";
  let calls: { url: string; auth: string | null }[] = [];

  beforeEach(() => {
    calls = [];
    process.env.OPENAI_API_KEY = KEY;
    process.env.BASE_URL = "https://sub2api.example.com";
    delete process.env.CODE;
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return new Response("ok");
    }) as any;
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.BASE_URL;
  });

  async function call(
    baseUrl: string,
    path: string[],
    method = "POST",
    auth?: string,
  ) {
    const headers: Record<string, string> = { "x-base-url": baseUrl };
    if (auth) headers["Authorization"] = auth;
    const req = new NextRequest(
      "https://chat.example.com/api/proxy/" + path.join("/"),
      {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      },
    );
    return handle(req, { params: { path } });
  }

  test.each([
    ["https://sub2api.example.com", ["v1", "images", "generations"], "POST"],
    ["https://sub2api.example.com/v1", ["images", "generations"], "POST"],
    ["https://sub2api.example.com", ["v1", "models"], "GET"],
  ])("injects the key for %p %p %p", async (baseUrl, path, method) => {
    await call(baseUrl, path, method);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(new URL(calls[0].url).host).toBe("sub2api.example.com");
  });

  test.each([
    "https://user@sub2api.example.com",
    "https://:pass@sub2api.example.com",
    "https://sub2api.example.com\\@evil.com/..",
    "https://sub2api.example.com\\@evil.com/%2e%2e",
    "https://sub2api.example.com/v1/images/generations?x=",
    "https://sub2api.example.com/v1/images/generations#",
  ])("no key for unsafe base url %p on an allowed path", async (baseUrl) => {
    await call(baseUrl, ["v1", "images", "generations"]);
    for (const c of calls) expect(c.auth ?? "").not.toContain(KEY);
  });

  test("fetches the normalized href it checked", async () => {
    await call("https://sub2api.example.com/x/..", ["v1", "models"], "GET");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sub2api.example.com/v1/models?");
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
  });

  test("rejects an unparsable base url", async () => {
    const res = await call("not a url", ["v1", "models"], "GET");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["https://sub2api.example.com", ["ops"], "POST"],
    ["https://sub2api.example.com", ["ops", "api", "x"], "GET"],
    ["https://sub2api.example.com/ops", ["x"], "POST"],
    ["https://sub2api.example.com", ["v1", "live"], "POST"],
    ["https://sub2api.example.com", ["v1", "live", "ws"], "GET"],
    [
      "https://sub2api.example.com",
      ["v1", "images", "..", "..", "ops"],
      "POST",
    ],
    [
      "https://sub2api.example.com",
      ["v1", "images", "%2e%2e", "%2E%2E", "ops"],
      "POST",
    ],
    [
      "https://sub2api.example.com",
      ["v1", "images", ".%2e", "%2e.", "ops"],
      "POST",
    ],
    [
      "https://sub2api.example.com/v1/images/generations/../../..",
      ["ops"],
      "POST",
    ],
    ["https://sub2api.example.com", ["v1", "images%2F..%2F..%2Fops"], "POST"],
    [
      "https://sub2api.example.com",
      ["v1", "", "images", "generations"],
      "POST",
    ],
    [
      "https://sub2api.example.com",
      ["", "v1", "images", "generations"],
      "POST",
    ],
    ["https://sub2api.example.com", ["v1", "%69mages", "generations"], "POST"],
    ["https://sub2api.example.com", ["v1", "images", "generations"], "GET"],
    ["https://sub2api.example.com", ["v1", "images", "generations"], "PUT"],
    ["https://sub2api.example.com", ["v1", "images", "generations"], "DELETE"],
    ["https://sub2api.example.com", ["v1", "models"], "POST"],
  ])("does not inject the key for %p %p %p", async (baseUrl, path, method) => {
    await call(baseUrl, path, method).catch(() => undefined);
    for (const c of calls) {
      expect(c.auth ?? "").not.toContain(KEY);
    }
  });

  test.each([
    "Bearer nk-secret",
    "bearer nk-secret",
    "BEARER nk-secret",
    "Bearer   nk-secret",
    "bearer\tnk-secret",
    "  Bearer nk-secret  ",
  ])("strips the access code %p for other hosts", async (auth) => {
    await call(
      "https://evil.com",
      ["v1", "images", "generations"],
      "POST",
      auth,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBeNull();
  });

  test("strips the access code for non-allowed paths on BASE_URL", async () => {
    await call(
      "https://sub2api.example.com",
      ["ops"],
      "POST",
      "bearer  nk-secret",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBeNull();
  });

  test("keeps a user api key for other hosts", async () => {
    await call(
      "https://evil.com",
      ["v1", "images", "generations"],
      "POST",
      "Bearer sk-user",
    );
    expect(calls[0].auth).toBe("Bearer sk-user");
  });
});
