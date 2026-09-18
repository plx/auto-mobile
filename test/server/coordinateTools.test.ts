import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import {
  hitTestSchema,
  tapAtSchema,
  snapshotOfSchema,
  registerCoordinateTools,
} from "../../src/server/coordinateTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  CoordinateGeometry,
  createSnapshotFrameStore,
} from "../../src/features/coordinates/CoordinateGeometry";
import { SnapshotOf } from "../../src/features/coordinates/SnapshotOf";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeImageUtils } from "../fakes/FakeImageUtils";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { getStructuredField } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";

const device: BootedDevice = { name: "test", platform: "android", deviceId: "test" };

describe("coordinate tool schemas", () => {
  test.each([tapAtSchema, hitTestSchema])("shares strict coordinate validation", (schema) => {
    expect(schema.safeParse({ x: 10, y: 20, deviceId: "test" }).success).toBe(true);
    expect(schema.safeParse({ x: 10, y: 20, relativeTo: { elementId: "view" } }).success).toBe(
      true,
    );
    for (const invalid of [
      { x: 1 },
      { x: Infinity, y: 0 },
      { x: 0, y: 0, extra: true },
      { x: { value: 1, unit: "dp" }, y: 0 },
      { x: 0, y: 0, relativeTo: { elementId: "a", snapshotId: "b" } },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  test("snapshotOf requires an element and defaults inline images off", () => {
    expect(snapshotOfSchema.parse({ elementId: "canvas" }).includeImage).toBe(false);
    expect(snapshotOfSchema.safeParse({ elementId: "canvas", includeImage: true }).success).toBe(
      true,
    );
    expect(snapshotOfSchema.safeParse({ elementId: "" }).success).toBe(false);
    expect(
      snapshotOfSchema.safeParse({ elementId: "canvas", path: "/tmp/overwrite" }).success,
    ).toBe(false);
  });
});

describe("coordinate tool registration", () => {
  afterEach(() => ToolRegistry.clearTools());

  test("hitTest reads fresh state without invoking either tap or screenshot", async () => {
    const observer = new FakeObserveScreen();
    observer.setObserveResult({
      observationId: "test",
      screenSize: { width: 100, height: 200 },
      viewHierarchy: { hierarchy: {}, screenWidth: 100, screenHeight: 200, fresh: true },
    });
    registerCoordinateTools({
      observer: () => observer,
      geometry: (d) => new CoordinateGeometry(d),
      snapshot: () => {
        throw new Error("unexpected screenshot");
      },
      tap: () => {
        throw new Error("unexpected tap");
      },
    });
    const handler = ToolRegistry.getTool("hitTest")!.deviceAwareHandler!;
    const result = await handler(device, { x: 10, y: 20 });
    expect(result.structuredContent).toMatchObject({
      success: true,
      point: { x: 10, y: 20 },
      element: null,
      dispatchGuaranteed: false,
    });
    expect(observer.getExecuteOptions()[0]).toMatchObject({
      skipWaitForFresh: false,
      skipScreenshot: true,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
    });
    const names = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    expect(names).toContain("tapAt");
    expect(names).toContain("snapshotOf");
  });

  test("stale hierarchies fail before reporting candidates", async () => {
    const observer = new FakeObserveScreen();
    observer.setObserveResult({
      observationId: "test",
      screenSize: { width: 100, height: 200 },
      viewHierarchy: { hierarchy: {}, screenWidth: 100, screenHeight: 200, fresh: false },
    });
    registerCoordinateTools({
      observer: () => observer,
      geometry: (d) => new CoordinateGeometry(d),
      snapshot: () => {
        throw new Error("unexpected screenshot");
      },
      tap: () => {
        throw new Error("unexpected tap");
      },
    });
    await expect(
      ToolRegistry.getTool("hitTest")!.deviceAwareHandler!(device, { x: 10, y: 20 }),
    ).rejects.toThrow("fresh hierarchy");
  });

  function setupSnapshot(moved = false) {
    const observer = new FakeObserveScreen();
    const tree = {
      hierarchy: {
        node: {
          $: {
            "resource-id": "canvas",
            bounds: { left: 10, top: 20, right: 90, bottom: 120 },
          },
        },
      },
      screenWidth: 100,
      screenHeight: 200,
      fresh: true,
    };
    const observation: ObserveResult = {
      observationId: "before",
      screenSize: { width: 100, height: 200 },
      viewHierarchy: tree,
    };
    const after = structuredClone(observation);
    if (moved) {
      after.viewHierarchy!.hierarchy.node!.$.bounds = {
        left: 20,
        top: 20,
        right: 100,
        bottom: 120,
      };
    }
    observer.setObserveSequence([observation, after]);
    const timer = new FakeTimer();
    const frames = createSnapshotFrameStore(timer);
    const images = new FakeImageUtils();
    images.setMetadataResult({ width: 100, height: 200, format: "png", size: 100 });
    registerCoordinateTools({
      observer: () => observer,
      geometry: (d) => new CoordinateGeometry(d, frames),
      tap: () => {
        throw new Error("unexpected tap");
      },
      snapshot: (d) =>
        new SnapshotOf(d, {
          screenshot: {
            execute: async () => ({ success: true, path: "/captures/full.png" }),
            generateScreenshotPath: () => "/captures/full.png",
            getActivityHash: async () => "test",
          },
          images,
          read: async () => Buffer.from("full"),
          writer: new FakeScreenshotFileWriter(),
          frames,
          timer,
          ids: new CountingIdGenerator(),
        }),
    });
  }

  test.each([undefined, false, true])(
    "snapshotOf routes JSON, path, and optional inline image (%s)",
    async (includeImage) => {
      setupSnapshot();
      const result = await ToolRegistry.getTool("snapshotOf")!.deviceAwareHandler!(device, {
        elementId: "canvas",
        ...(includeImage === undefined ? {} : { includeImage }),
      });
      expect(getStructuredField(result, "snapshot")).toMatchObject({
        path: "/captures/element-id-1.png",
        width: 80,
        height: 100,
      });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(result.content).toHaveLength(includeImage ? 2 : 1);
      if (includeImage) {
        expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      }
    },
  );

  test("snapshotOf rejects a view that moved during capture", async () => {
    setupSnapshot(true);
    await expect(
      ToolRegistry.getTool("snapshotOf")!.deviceAwareHandler!(device, { elementId: "canvas" }),
    ).rejects.toThrow("geometry has changed");
  });
});
