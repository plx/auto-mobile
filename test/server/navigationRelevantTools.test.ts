import { expect, describe, test } from "bun:test";
import { NAVIGATION_RELEVANT_TOOLS } from "../../src/server/toolRegistry";

describe("NAVIGATION_RELEVANT_TOOLS", () => {
  test("is a Set for O(1) membership checks", () => {
    expect(NAVIGATION_RELEVANT_TOOLS).toBeInstanceOf(Set);
  });

  test("contains exactly the UI-interaction tools that may cause navigation", () => {
    expect([...NAVIGATION_RELEVANT_TOOLS].sort()).toEqual([
      "clearText",
      "dragAndDrop",
      "imeAction",
      "inputText",
      "pinchOn",
      "pressButton",
      "sendKeys",
      "swipeOn",
      "tapAt",
      "tapOn",
    ]);
  });

  test("excludes app-lifecycle and observation tools", () => {
    for (const tool of [
      "launchApp",
      "terminateApp",
      "homeScreen",
      "observe",
      "installApp",
      "hitTest",
      "snapshotOf",
    ]) {
      expect(NAVIGATION_RELEVANT_TOOLS.has(tool)).toBe(false);
    }
  });
});
