import { gptImageQuality } from "../app/utils/model";

describe("gptImageQuality", () => {
  test("maps hd to high", () => {
    expect(gptImageQuality("hd")).toBe("high");
  });

  test("drops standard and unset so the upstream default applies", () => {
    expect(gptImageQuality("standard")).toBeUndefined();
    expect(gptImageQuality(undefined)).toBeUndefined();
  });
});
