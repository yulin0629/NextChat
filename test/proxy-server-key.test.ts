/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { handle, isServerUpstream } from "../app/api/proxy";

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
