/**
 * @jest-environment node
 */
jest.mock("../app/api/auth", () => ({ auth: () => ({ error: false }) }));
jest.mock("../app/api/common", () => ({
  requestOpenai: jest.fn(async () => new Response("{}", { status: 200 })),
}));

import { NextRequest } from "next/server";
import { handle } from "../app/api/openai";
import { parseSub2ApiUsage } from "../app/utils/sub2api-usage";
import { requestOpenai as requestOpenaiMock } from "../app/api/common";

const requestOpenai = requestOpenaiMock as jest.Mock;

// shape of Sub2API GET /v1/usage for a key with a total quota and 5h/1d/7d limits
const QUOTA_LIMITED = {
  mode: "quota_limited",
  isValid: true,
  status: "active",
  quota: { limit: 100, used: 3.14159, remaining: 96.85841, unit: "USD" },
  remaining: 96.85841,
  unit: "USD",
  rate_limits: [
    { window: "5h", limit: 6, used: 0.123, remaining: 5.877, window_start: null },
    { window: "1d", limit: 10, used: 1.5, remaining: 8.5, window_start: null },
    { window: "7d", limit: 30, used: 3.14159, remaining: 26.86, window_start: null },
  ],
};

describe("parseSub2ApiUsage", () => {
  test("reads total quota and each window, rounded to cents", () => {
    expect(parseSub2ApiUsage(QUOTA_LIMITED)).toEqual({
      used: 3.14,
      total: 100,
      windows: [
        { window: "5h", used: 0.12, limit: 6 },
        { window: "1d", used: 1.5, limit: 10 },
        { window: "7d", used: 3.14, limit: 30 },
      ],
    });
  });

  test("leaves numbers unknown for a key without limits", () => {
    expect(parseSub2ApiUsage({ mode: "unrestricted", unit: "USD" })).toEqual({
      used: undefined,
      total: undefined,
      windows: undefined,
    });
  });

  test("throws the gateway's error message", () => {
    expect(() =>
      parseSub2ApiUsage({ error: { type: "authentication_error", message: "Invalid API key" } }),
    ).toThrow("Invalid API key");
  });
});

describe("/api/openai proxy", () => {
  const call = (path: string[]) =>
    handle(new NextRequest(`http://localhost/api/openai/${path.join("/")}`), {
      params: { path },
    });

  test("forwards v1/usage to the gateway", async () => {
    requestOpenai.mockClear();
    const res = await call(["v1", "usage"]);
    expect(res.status).toBe(200);
    expect(requestOpenai).toHaveBeenCalledTimes(1);
  });

  test("still refuses paths outside the allowlist", async () => {
    requestOpenai.mockClear();
    const res = await call(["v1", "admin", "keys"]);
    expect(res.status).toBe(403);
    expect(requestOpenai).not.toHaveBeenCalled();
  });
});
