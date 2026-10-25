// Built-in Web Search tool: the OpenAPI spec the model sees. app/store/plugin.ts
// registers it; app/api/search serves it. On by default in new chats (app/store/mask.ts).
export const WEB_SEARCH_PLUGIN_ID = "websearch";

export const WEB_SEARCH_SPEC = {
  openapi: "3.0.1",
  info: { title: "Web Search", version: "1.0.0" },
  servers: [{ url: "/api" }],
  paths: {
    "/search": {
      post: {
        operationId: "web_search",
        summary: "Search the web",
        description:
          "Search the web and get page titles, URLs and text excerpts. Use it for recent events, current facts, and anything you are not sure about or that may have changed since your training data.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description:
                      "A full natural-language phrase describing the page you want to find, not a bare keyword. Include names, dates and the language or library when they matter.",
                  },
                },
                required: ["query"],
              },
            },
          },
        },
        responses: { "200": { description: "Search results" } },
      },
    },
  },
};
