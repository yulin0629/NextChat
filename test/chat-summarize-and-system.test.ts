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

  test("the retry's summary becomes the memory", () => {
    run("claude-sonnet-5-5", true);
    const session = useChatStore.getState().currentSession();
    expect(session.memoryPrompt).toBe("A Fine Title");
    expect(session.lastSummarizeIndex).toBe(1);
  });

  // a stream that fails part-way can still report later: onUpdate from its animation,
  // onFinish with status 200 when it is aborted
  function summarizeWith(firstAttempt: (options: any) => void, retry: (options: any) => void) {
    useAccessStore.setState({ customModels: "-all,+gpt-6-luna=GPT-6 Luna,+claude-sonnet-5-5" });
    chat.mockReset();
    chat.mockImplementation((options: any) => {
      if (!options.config.stream) return options.onFinish("A Fine Title", { status: 200 });
      (options.config.model === "gpt-6-luna" ? firstAttempt : retry)(options);
    });
    const session = sessionWith("claude-sonnet-5-5");
    useChatStore.getState().updateTargetSession(session, (s) => {
      s.messages = [createMessage({ role: "user", content: LONGER })];
      s.memoryPrompt = "GOOD OLD MEMORY";
    });
    useChatStore.getState().summarizeSession(false, useChatStore.getState().currentSession());
    return chat.mock.calls.filter((c) => c[0].config.stream).map((c) => c[0]);
  }

  test("a failed stream that reports late does not overwrite the retry's memory", () => {
    const [first] = summarizeWith(
      (o) => {
        o.onUpdate?.("PARTIAL FROM LUNA");
        o.onError(new Error("connection reset"));
      },
      (o) => o.onFinish("FULL SUMMARY", { status: 200 }),
    );
    first.onUpdate?.("PARTIAL FROM LUNA, MORE");
    first.onFinish("PARTIAL FROM LUNA, MORE", { status: 200 });
    expect(useChatStore.getState().currentSession().memoryPrompt).toBe("FULL SUMMARY");
  });

  test("the old memory stays when every attempt fails part-way or comes back empty", () => {
    const halfThenError = (o: any) => {
      o.onUpdate?.("HALF");
      o.onError(new Error("connection reset"));
    };
    summarizeWith(halfThenError, halfThenError);
    let session = useChatStore.getState().currentSession();
    expect(session.memoryPrompt).toBe("GOOD OLD MEMORY");
    expect(session.lastSummarizeIndex).toBe(0);

    const calls = summarizeWith(
      (o) => o.onFinish("", { status: 200 }),
      (o) => o.onFinish("", { status: 200 }),
    );
    expect(calls).toHaveLength(2);
    session = useChatStore.getState().currentSession();
    expect(session.memoryPrompt).toBe("GOOD OLD MEMORY");
  });

  test("the summary request has no system message after the conversation starts", () => {
    const [first] = summarizeWith(
      (o) => o.onFinish("FULL SUMMARY", { status: 200 }),
      () => {},
    );
    const roles = first.messages.map((m: any) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles.slice(1)).not.toContain("system");
    expect(roles[roles.length - 1]).toBe("user");
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

  test("prompt, memory and mask context arrive as one leading system message", async () => {
    const session = sessionWith("qwen3.8-27b");
    useChatStore.getState().updateTargetSession(session, (s) => {
      s.memoryPrompt = "Earlier: the user likes tea.";
      s.lastSummarizeIndex = 1;
      s.mask.context = [createMessage({ role: "system", content: "You are a tea expert." })];
    });
    const messages = await useChatStore.getState().getMessagesWithMemory();
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    const system = messages[0].content as string;
    expect(system).toContain("Current model: qwen3.8-27b");
    expect(system).toContain("Earlier: the user likes tea.");
    expect(system).toContain("You are a tea expert.");
  });

  test("stays identical within a day, so the prompt cache keeps hitting", async () => {
    sessionWith("gemini-4-argon");
    jest.useFakeTimers().setSystemTime(new Date(2026, 9, 28, 9, 0, 0));
    const first = await systemPrompt();
    jest.setSystemTime(new Date(2026, 9, 28, 21, 47, 31));
    expect(await systemPrompt()).toBe(first);
  });
});
