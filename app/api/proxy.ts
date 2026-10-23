import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import {
  ACCESS_CODE_PREFIX,
  ModelProvider,
  OPENAI_BASE_URL,
  OpenaiPath,
} from "@/app/constant";
import { auth } from "./auth";

// The system api key may only be sent to the configured upstream (BASE_URL,
// or api.openai.com when BASE_URL is unset). Compare parsed protocol, hostname
// and port exactly; never use substring checks on client-supplied urls.
function normalizeUpstream(baseUrl?: string) {
  let upstream = baseUrl || OPENAI_BASE_URL;
  if (!upstream.startsWith("http")) {
    upstream = `https://${upstream}`;
  }
  return upstream.replace(/\/+$/, "");
}

export function isServerUpstream(target: string | null, baseUrl?: string) {
  try {
    const expected = new URL(normalizeUpstream(baseUrl));
    const actual = new URL(target ?? "");
    return (
      !actual.username &&
      !actual.password &&
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port
    );
  } catch {
    return false;
  }
}

// Same paths as the /api/openai ALLOWED_PATH list, each with the only method
// it needs. Any other path or method on the upstream host gets no system key.
const SERVER_KEY_METHODS: Record<keyof typeof OpenaiPath, string> = {
  ChatPath: "POST",
  SpeechPath: "POST",
  ImagePath: "POST",
  UsagePath: "GET",
  SubsPath: "GET",
  ListModelPath: "GET",
};

// Only send the system api key when the request goes to the configured
// upstream AND the WHATWG-normalized path (dot segments, %2e, etc. resolved)
// is an allowed OpenAI path built the same way as app/api/common.ts builds it
// (`${BASE_URL}/${path}`). handle() must fetch the same normalized href it
// checked: workerd fetch() before compat date 2024-06-03 parses some raw urls
// (e.g. "https://host\@evil.com/..") differently from new URL().
export function canUseServerKey(
  target: string | null,
  method: string,
  baseUrl?: string,
) {
  if (!isServerUpstream(target, baseUrl)) return false;
  try {
    const pathname = new URL(target ?? "").pathname;
    const upstream = normalizeUpstream(baseUrl);
    return (Object.keys(OpenaiPath) as (keyof typeof OpenaiPath)[]).some(
      (name) =>
        new URL(`${upstream}/${OpenaiPath[name]}`).pathname === pathname &&
        SERVER_KEY_METHODS[name] === method.toUpperCase(),
    );
  } catch {
    return false;
  }
}

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[Proxy Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }
  const serverConfig = getServerSideConfig();

  // remove path params from searchParams
  req.nextUrl.searchParams.delete("path");
  req.nextUrl.searchParams.delete("provider");

  const subpath = params.path.join("/");
  const baseUrl = req.headers.get("x-base-url") ?? "";
  let fetchUrl: string;
  try {
    fetchUrl = new URL(
      `${baseUrl}/${subpath}?${req.nextUrl.searchParams.toString()}`,
    ).href;
  } catch {
    return NextResponse.json(
      { error: true, msg: "invalid x-base-url" },
      { status: 400 },
    );
  }
  // A base url carrying "?" or "#" would swallow the subpath, and "\\" or
  // control characters parse differently across runtimes: no system key then.
  const plainBaseUrl = !/[?#\\\u0000-\u0020\u007f]/.test(baseUrl);

  // use the system api key (e.g. the dalle3 plugin), only for allowed upstream paths
  if (
    plainBaseUrl &&
    canUseServerKey(fetchUrl, req.method, serverConfig.baseUrl)
  ) {
    const authResult = auth(req, ModelProvider.GPT);
    if (authResult.error) {
      return NextResponse.json(authResult, { status: 401 });
    }
  } else if (
    req.headers
      .get("Authorization")
      ?.trim()
      .replace(/^bearer\s+/i, "")
      .startsWith(ACCESS_CODE_PREFIX)
  ) {
    // do not forward the access code to third-party hosts
    req.headers.delete("Authorization");
  }
  const skipHeaders = ["connection", "host", "origin", "referer", "cookie"];
  const headers = new Headers(
    Array.from(req.headers.entries()).filter((item) => {
      if (
        item[0].indexOf("x-") > -1 ||
        item[0].indexOf("sec-") > -1 ||
        skipHeaders.includes(item[0])
      ) {
        return false;
      }
      return true;
    }),
  );
  const controller = new AbortController();
  const fetchOptions: RequestInit = {
    headers,
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
