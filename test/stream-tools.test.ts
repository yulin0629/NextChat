jest.mock("../app/utils", () => ({ getTimeoutMSByModel: () => 60000 }));
jest.mock("../app/locales", () => ({ __esModule: true, default: {} }));
jest.mock("../app/utils/stream", () => ({ fetch: jest.fn() }));
jest.mock("@fortaine/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: jest.fn(),
}));

import { fetchEventSource } from "@fortaine/fetch-event-source";
import { stream, streamWithThink } from "../app/utils/chat";

const tools = [{ type: "function", function: { name: "search_web" } }];

function sentTools(fn: typeof stream | typeof streamWithThink, options: any) {
  (fetchEventSource as jest.Mock).mockClear();
  fn(
    "/api/openai/v1/chat/completions",
    { model: "gpt-6-luna", messages: [] },
    {},
    tools,
    {},
    new AbortController(),
    (() => undefined) as any,
    () => {},
    options,
  );
  const init = (fetchEventSource as jest.Mock).mock.calls[0][1];
  return JSON.parse(init.body).tools;
}

describe.each([
  ["stream", stream],
  ["streamWithThink", streamWithThink],
])("%s tools", (_, fn) => {
  test("sends tools for a user turn", () => {
    expect(sentTools(fn, { onBeforeTool: () => {} })).toEqual(tools);
  });

  test("omits tools for a memory summary request", () => {
    expect(sentTools(fn, { onUpdate: () => {} })).toBeUndefined();
  });
});
