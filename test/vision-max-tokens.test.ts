// What the client sends for a model, depending on how it counts as a vision model.
jest.mock("nanoid", () => ({ nanoid: () => "id" }));
const access = { visionModels: "", useCustomConfig: false, openaiUrl: "" };
jest.mock("@/app/store", () => ({
  useAccessStore: { getState: () => access },
  useAppConfig: { getState: () => ({ modelConfig: { max_tokens: 4000, temperature: 0.5, top_p: 1 } }) },
  useChatStore: { getState: () => ({ currentSession: () => ({ mask: { modelConfig: {}, plugin: [] } }) }) },
  usePluginStore: { getState: () => ({ getAsTools: () => [[], {}] }) },
  ChatMessageTool: {},
}));
jest.mock("@/app/utils/stream", () => ({ fetch: jest.fn() }));
jest.mock("@/app/components/ui-lib", () => ({ showToast: jest.fn() }));
jest.mock("@/app/locales", () => ({ __esModule: true, default: { Error: {} } }));
jest.mock("../app/client/api", () => ({ getHeaders: () => ({}) }));

import { fetch as sendMock } from "@/app/utils/stream";
import { ChatGPTApi } from "../app/client/platforms/openai";

async function sentPayload(model: string) {
  const send = sendMock as jest.Mock;
  send.mockReset();
  send.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
  });
  await new ChatGPTApi().chat({
    messages: [{ role: "user", content: "hi" }],
    config: { model, stream: false },
    onFinish: () => {},
    onError: (e: unknown) => {
      throw e;
    },
  } as any);
  return JSON.parse(send.mock.calls[0][1].body);
}

describe("vision models and max_tokens", () => {
  test("a model listed in VISION_MODELS sends no max_tokens, as before it was listed", async () => {
    access.visionModels = "gemini-4-argon,k3.1-pro";
    expect(await sentPayload("gemini-4-argon")).not.toHaveProperty("max_tokens");
  });

  test("an unlisted, non-vision model sends no max_tokens", async () => {
    access.visionModels = "";
    expect(await sentPayload("gemini-4-argon")).not.toHaveProperty("max_tokens");
  });

  test("built-in vision models keep upstream's 4000 floor", async () => {
    access.visionModels = "";
    expect((await sentPayload("claude-sonnet-5-5")).max_tokens).toBe(4000);
  });
});
