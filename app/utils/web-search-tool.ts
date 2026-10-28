// Built-in Web Search tool: the OpenAPI spec the model sees. app/store/plugin.ts
// registers it; app/api/search and app/api/fetch serve it. On by default in new chats (app/store/mask.ts).
// The tool is not named "web_search": the gateway (Sub2API) treats that name as a
// native search tool on some upstreams and counts its calls as such.
export const WEB_SEARCH_PLUGIN_ID = "websearch";

export const WEB_SEARCH_SPEC = {
  openapi: "3.0.1",
  info: { title: "Web Search", version: "1.1.0" },
  servers: [{ url: "/api" }],
  paths: {
    "/search": {
      post: {
        operationId: "search_web",
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
    "/fetch": {
      post: {
        operationId: "fetch_url",
        summary: "Read a web page",
        description:
          "Fetch one web page and get its plain text (up to about 12,000 characters). Use it to read a search result or a link the user gave you in full. Pages that only render with JavaScript may come back empty.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "The full http or https address of the page.",
                  },
                },
                required: ["url"],
              },
            },
          },
        },
        responses: { "200": { description: "Page text" } },
      },
    },
  },
};
