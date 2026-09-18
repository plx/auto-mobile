import { describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { SnapshotOf } from "../../../src/features/coordinates/SnapshotOf";
import {
  CoordinateGeometry,
  createSnapshotFrameStore,
} from "../../../src/features/coordinates/CoordinateGeometry";
import type { ScreenshotService } from "../../../src/features/observe/interfaces/ScreenshotService";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { screenshotFileBelongsToDevice } from "../../../src/utils/screenshot/screenshotFormats";
import { FakeImageUtils } from "../../fakes/FakeImageUtils";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { hitTestResultSchema, snapshotOfResultSchema } from "../../../src/server/coordinateTools";

const device: BootedDevice = { name: "test", deviceId: "ios-test", platform: "ios" };
const hierarchy = (): ViewHierarchyResult => ({
  screenWidth: 400,
  screenHeight: 800,
  rotation: 0,
  hierarchy: {
    node: {
      $: {
        "resource-id": "canvas",
        bounds: { left: 10.25, top: -20, right: 110.25, bottom: 100 },
      },
    },
  },
});

class FakeCapture implements ScreenshotService {
  calls = 0;
  success = true;
  async execute() {
    this.calls++;
    return {
      success: this.success,
      path: this.success ? "/captures/screenshot_1_ios-test_id.png" : undefined,
      error: "capture failed",
    };
  }
  generateScreenshotPath() {
    return "/captures/full.png";
  }
  async getActivityHash() {
    return "test";
  }
}

function setup(writer = new FakeScreenshotFileWriter()) {
  const timer = new FakeTimer();
  const frames = createSnapshotFrameStore(timer);
  const images = new FakeImageUtils();
  images.setMetadataResult({ width: 1200, height: 2400, format: "png", size: 100 });
  const capture = new FakeCapture();
  const snapshot = new SnapshotOf(device, {
    screenshot: capture,
    images,
    read: async () => Buffer.from("full-screen"),
    writer,
    frames,
    timer,
    ids: new CountingIdGenerator("snapshot"),
  });
  return { snapshot, capture, images, frames, writer };
}

describe("SnapshotOf", () => {
  test("round-trips fractional, clipped Retina crop coordinates through hitTest", async () => {
    const { snapshot, images, frames, writer } = setup();
    const tree = hierarchy();
    const result = await snapshot.execute(tree, "canvas");
    expect(images.getMethodCalls("crop")[0]).toMatchObject({
      width: 301,
      height: 300,
      x: 30,
      y: 0,
    });
    expect(result.payload.snapshot).toMatchObject({
      width: 301,
      height: 300,
      clipped: true,
      pixelsPerUnit: { x: 3, y: 3 },
    });
    expect(writer.written).toEqual([result.payload.snapshot.path]);
    expect(
      screenshotFileBelongsToDevice(
        result.payload.snapshot.path.split("/").at(-1)!,
        device.deviceId,
      ),
    ).toBe(false);
    expect(snapshotOfResultSchema.safeParse(result.payload).success).toBe(true);
    const hit = new CoordinateGeometry(device, frames).hitTest(tree, {
      relativeTo: result.payload.relativeTo,
      x: 30,
      y: 60,
    });
    expect(hit.point).toEqual({ x: 20, y: 20 });
    expect(hit.element?.elementId).toBe("canvas");
    expect(hitTestResultSchema.safeParse(hit).success).toBe(true);
    // The outward-rounded first column includes pixels outside the original element.
    expect(() =>
      new CoordinateGeometry(device, frames).resolve(tree, {
        relativeTo: result.payload.relativeTo,
        x: 0,
        y: 60,
      }),
    ).toThrow("outside");
  });

  test("capture failure produces no crop or reusable reference", async () => {
    const { snapshot, capture, writer } = setup();
    capture.success = false;
    await expect(snapshot.execute(hierarchy(), "canvas")).rejects.toThrow("capture failed");
    expect(writer.written).toEqual([]);
  });

  test("rejects orientation mismatch between hierarchy and image", async () => {
    const { snapshot, images, writer } = setup();
    images.setMetadataResult({ width: 2400, height: 1200, format: "png", size: 100 });
    await expect(snapshot.execute(hierarchy(), "canvas")).rejects.toThrow("geometry disagree");
    expect(writer.written).toEqual([]);
  });

  test("rejects an off-screen element before capturing", async () => {
    const { snapshot, capture } = setup();
    const tree = hierarchy();
    tree.hierarchy.node!.$.bounds = { left: 500, top: 0, right: 600, bottom: 100 };
    await expect(snapshot.execute(tree, "canvas")).rejects.toThrow("off screen");
    expect(capture.calls).toBe(0);
  });

  test("cancellation during write removes the crop and publishes no reference", async () => {
    const controller = new AbortController();
    const writer = new FakeScreenshotFileWriter(() => controller.abort());
    const { snapshot, frames } = setup(writer);
    await expect(snapshot.execute(hierarchy(), "canvas", controller.signal)).rejects.toThrow();
    expect(writer.removed).toEqual(writer.written);
    expect(frames.get("snapshot-2")).toBeUndefined();
  });
});
