// app/utils pulls in the whole store/UI graph; only showPlugins is under test.
jest.mock("../app/store", () => ({ useAccessStore: { getState: () => ({}) } }));
jest.mock("../app/components/ui-lib", () => ({ showToast: jest.fn() }));
jest.mock("../app/locales", () => ({ __esModule: true, default: {} }));
jest.mock("../app/utils/stream", () => ({ fetch: jest.fn() }));

import { ServiceProvider } from "../app/constant";
import { showPlugins } from "../app/utils";

describe("showPlugins", () => {
  test("shows the tool button for a custom model's own provider name", () => {
    expect(showPlugins("gpt-6.1-sol" as any, "gpt-6.1-sol")).toBe(true);
    expect(showPlugins("claude-sonnet-5-5" as any, "claude-sonnet-5-5")).toBe(
      true,
    );
  });

  test("keeps the existing rules for named providers", () => {
    expect(showPlugins(ServiceProvider.OpenAI, "gpt-4o")).toBe(true);
    expect(showPlugins(ServiceProvider.Anthropic, "claude-3-5-sonnet")).toBe(
      true,
    );
    expect(showPlugins(ServiceProvider.Anthropic, "claude-2")).toBe(false);
    expect(showPlugins(ServiceProvider.Google, "gemini-pro-vision")).toBe(
      false,
    );
    expect(showPlugins(ServiceProvider.Baidu, "ernie-4.0")).toBe(false);
  });
});
