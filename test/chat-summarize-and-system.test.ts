// The chat store pulls in MCP (server-only), UI and the network client; stub those edges.
jest.mock("nanoid", () => {
  let n = 0;
  return { nanoid: () => `id-${n++}` };
});
jest.mock("../app/mcp/actions", () => ({
  executeMcpAction: jest.fn(),
  getAllTools: jest.fn(async () => []),
  isMcpEnabled: jest.fn(async () => false),
}));
jest.mock("../app/components/ui-lib", () => ({ showToast: jest.fn() }));
const chat = jest.fn();
jest.mock("../app/client/api", () => ({
  getClientApi: () => ({ llm: { chat } }),
  getHeaders: () => ({}),
}));

import { useChatStore } from "../app/store/chat";
import { useAccessStore } from "../app/store/access";
import { createEmptyMask } from "../app/store/mask";
import { createMessage } from "../app/store/chat";

const LONG = "word ".repeat(80);

function sessionWith(model: string) {
  const mask = createEmptyMask();
  mask.modelConfig = { ...mask.modelConfig, model: model as any, providerName: model as any };
  useChatStore.getState().newSession(mask);
  const session = useChatStore.getState().currentSession();
  useChatStore.getState().updateTargetSession(session, (s) => {
    s.messages = [
      createMessage({ role: "user", content: LONG }),
      createMessage({ role: "assistant", content: LONG }),
    ];
  });
  return useChatStore.getState().currentSession();
}

function titleModel(model: string) {
  chat.mockClear();
  useChatStore.getState().summarizeSession(false, sessionWith(model));
  return chat.mock.calls[0]?.[0]?.config?.model;
}

describe("title and memory summary model", () => {
  test("uses gpt-6-luna for any chat when it is in the model list", () => {
    useAccessStore.setState({
      customModels: "-all,+gpt-6-luna=GPT-6 Luna,+gemini-4-argon,+deepseek-flash,+claude-sonnet-5-5",
    });
    expect(titleModel("gemini-4-argon")).toBe("gpt-6-luna");
    expect(titleModel("deepseek-flash")).toBe("gpt-6-luna");
    expect(titleModel("claude-sonnet-5-5")).toBe("gpt-6-luna");
  });

  test("falls back to the chat's own model, not an unlisted fixed one", () => {
    useAccessStore.setState({ customModels: "-all,+gemini-4-argon" });
    expect(titleModel("gemini-4-argon")).toBe("gemini-4-argon");
  });
});

describe("system prompt", () => {
  test("every model gets its name and the current time, not a ChatGPT persona", async () => {
    sessionWith("claude-sonnet-5-5");
    const messages = await useChatStore.getState().getMessagesWithMemory();
    const system = messages.find((m) => m.role === "system")?.content as string;
    expect(system).toContain("Current model: claude-sonnet-5-5");
    expect(system).toMatch(/Current time: .*\d{4}/);
    expect(system).not.toContain("ChatGPT");
    expect(system).not.toContain("Knowledge cutoff");
  });
});
