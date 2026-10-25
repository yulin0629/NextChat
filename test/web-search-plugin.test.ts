// app/utils and the access store pull in the whole store/UI graph; the plugin store needs little of it.
jest.mock("../app/utils", () => ({
  adapter: jest.fn(),
  getOperationId: (o: { operationId?: string }) => o.operationId,
  safeLocalStorage: () => window.localStorage,
}));
jest.mock("../app/store/access", () => ({
  useAccessStore: { getState: () => ({}) },
}));
// the deployed web build, not the desktop app
jest.mock("../app/config/client", () => ({
  getClientConfig: () => ({ isApp: false }),
}));
jest.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { WEB_SEARCH_PLUGIN_ID } from "../app/utils/web-search-tool";
import { FunctionToolService, usePluginStore } from "../app/store/plugin";

describe("built-in web search plugin", () => {
  beforeAll(async () => {
    await usePluginStore.persist.rehydrate();
  });

  test("is created on load and marked built-in", () => {
    const plugin = usePluginStore.getState().get(WEB_SEARCH_PLUGIN_ID);
    expect(plugin?.builtin).toBe(true);
    expect(plugin?.title).toBe("Web Search");
  });

  test("becomes one web_search function that takes a query", () => {
    const [tools, funcs] = usePluginStore
      .getState()
      .getAsTools([WEB_SEARCH_PLUGIN_ID]) as [any[], Record<string, Function>];
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("web_search");
    expect(tools[0].function.parameters.required).toEqual(["query"]);
    expect(Object.keys(funcs)).toEqual(["web_search"]);
  });

  test("calls this app's /api/search directly, not through /api/proxy", () => {
    const { api } = FunctionToolService.tools[WEB_SEARCH_PLUGIN_ID];
    expect(api.axiosConfigDefaults.baseURL).toBe("/api");
    expect(
      (api.axiosConfigDefaults.headers as Record<string, unknown>)[
        "X-Base-URL"
      ],
    ).toBeUndefined();
  });

  test("other plugins still go through /api/proxy", () => {
    const tool = FunctionToolService.add(
      {
        id: "remote",
        createdAt: 0,
        title: "remote",
        version: "1",
        builtin: false,
        content: JSON.stringify({
          openapi: "3.0.1",
          info: { title: "r", version: "1" },
          servers: [{ url: "https://plugin.example.com" }],
          paths: {
            "/x": {
              get: {
                operationId: "x",
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      },
      true,
    );
    expect(tool.api.axiosConfigDefaults.baseURL).toBe("/api/proxy");
    expect(
      (tool.api.axiosConfigDefaults.headers as Record<string, unknown>)[
        "X-Base-URL"
      ],
    ).toBe("https://plugin.example.com");
  });
});
