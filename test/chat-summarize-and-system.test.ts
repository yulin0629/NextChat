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

describe("when the summarize model fails", () => {
  const LONGER = "word ".repeat(900);

  let alsoOnError = false;
  function run(model: string, longChat = false, ok = (m: string) => m !== "gpt-6-luna") {
    useAccessStore.setState({
      customModels: "-all,+gpt-6-luna=GPT-6 Luna,+claude-sonnet-5-5",
    });
    chat.mockReset();
    chat.mockImplementation((options: any) =>
      ok(options.config.model)
        ? options.onFinish("A Fine Title", { status: 200 })
        : (options.onFinish("upstream error", { status: 502 }),
          // some failures report through both callbacks
          alsoOnError && options.onError?.(new Error("upstream error"))),
    );
    const session = sessionWith(model);
    if (longChat) {
      useChatStore.getState().updateTargetSession(session, (s) => {
        s.messages = [createMessage({ role: "user", content: LONGER })];
      });
    }
    useChatStore.getState().summarizeSession(false, useChatStore.getState().currentSession());
    return chat.mock.calls.map((c) => [c[0].config.stream, c[0].config.model]);
  }

  afterEach(() => (alsoOnError = false));

  test.each([false, true])("the title is retried once with the chat's own model (also onError: %s)", (both) => {
    alsoOnError = both;
    expect(run("claude-sonnet-5-5")).toEqual([
      [false, "gpt-6-luna"],
      [false, "claude-sonnet-5-5"],
    ]);
    expect(useChatStore.getState().currentSession().topic).toBe("A Fine Title");
  });

  test.each([false, true])("the memory summary is retried the same way (also onError: %s)", (both) => {
    alsoOnError = both;
    const calls = run("claude-sonnet-5-5", true).filter(([stream]) => stream);
    expect(calls).toEqual([
      [true, "gpt-6-luna"],
      [true, "claude-sonnet-5-5"],
    ]);
  });

  test("no retry when the summarize model works, and at most one when both fail", () => {
    expect(run("claude-sonnet-5-5", false, () => true)).toEqual([[false, "gpt-6-luna"]]);
    expect(run("claude-sonnet-5-5", false, () => false)).toHaveLength(2);
    alsoOnError = true;
    expect(run("claude-sonnet-5-5", false, () => false)).toHaveLength(2);
  });
});

describe("system prompt", () => {
  afterEach(() => jest.useRealTimers());

  async function systemPrompt() {
    const messages = await useChatStore.getState().getMessagesWithMemory();
    return messages.find((m) => m.role === "system")?.content as string;
  }

  test("every model gets its name and today's date, not a ChatGPT persona", async () => {
    // local noon, so the local date is 2026-10-28 in any time zone
    jest.useFakeTimers().setSystemTime(new Date(2026, 9, 28, 12, 4, 5));
    sessionWith("claude-sonnet-5-5");
    const system = await systemPrompt();
    expect(system).toContain("Current model: claude-sonnet-5-5");
    expect(system).toMatch(/Current date: 2026-10-28 \(.+\)/);
    expect(system).not.toContain("ChatGPT");
    expect(system).not.toContain("Knowledge cutoff");
  });

  test("stays identical within a day, so the prompt cache keeps hitting", async () => {
    sessionWith("gemini-4-argon");
    jest.useFakeTimers().setSystemTime(new Date(2026, 9, 28, 9, 0, 0));
    const first = await systemPrompt();
    jest.setSystemTime(new Date(2026, 9, 28, 21, 47, 31));
    expect(await systemPrompt()).toBe(first);
  });
});
