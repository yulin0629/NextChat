// mask.ts pulls in the chat store and the UI locales; a new chat's default tools are all that is under test.
jest.mock("../app/masks", () => ({ BUILTIN_MASKS: [] }));
jest.mock("../app/locales", () => ({ getLang: () => "en" }));
jest.mock("../app/store/chat", () => ({ DEFAULT_TOPIC: "New Conversation" }));
jest.mock("../app/store/config", () => ({
  useAppConfig: { getState: () => ({ modelConfig: {} }) },
}));
jest.mock("../app/utils/store", () => ({ createPersistStore: () => ({}) }));
jest.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { createEmptyMask } from "../app/store/mask";
import { WEB_SEARCH_PLUGIN_ID } from "../app/utils/web-search-tool";

describe("new chat defaults", () => {
  test("starts with web search switched on", () => {
    expect(createEmptyMask().plugin).toEqual([WEB_SEARCH_PLUGIN_ID]);
  });
});
