/**
 * @jest-environment node
 */
import { getServerSideConfig } from "../app/config/server";

describe("Google Analytics", () => {
  const realGa = process.env.GA_ID;
  afterEach(() => {
    if (realGa === undefined) delete process.env.GA_ID;
    else process.env.GA_ID = realGa;
  });

  test("is off unless GA_ID is set", () => {
    delete process.env.GA_ID;
    expect(getServerSideConfig().gaId).toBeFalsy();
    process.env.GA_ID = "G-OWN";
    expect(getServerSideConfig().gaId).toBe("G-OWN");
  });
});
