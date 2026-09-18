import { describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import {
  CoordinateGeometry,
  createSnapshotFrameStore,
  SNAPSHOT_FRAME_TTL_MS,
  type CoordinateSnapshotFrame,
} from "../../../src/features/coordinates/CoordinateGeometry";
import { FakeTimer } from "../../fakes/FakeTimer";

const android: BootedDevice = { name: "test", deviceId: "test-android", platform: "android" };
const ios: BootedDevice = { ...android, platform: "ios" };
const bounds = { left: 100, top: 200, right: 300, bottom: 400 };
const node = (id: string, children: ViewHierarchyNode[] = []): ViewHierarchyNode => ({
  $: { "resource-id": id, bounds, clickable: true },
  node: children,
});
const hierarchy = (): ViewHierarchyResult => ({
  screenWidth: 400,
  screenHeight: 800,
  nativeScale: 3,
  rotation: 0,
  hierarchy: { node: node("canvas") },
  fresh: true,
  frameContext: "current-frame",
});

describe("CoordinateGeometry", () => {
  test("resolves screen coordinates even with no accessible children", () => {
    const tree = { ...hierarchy(), hierarchy: {} };
    expect(new CoordinateGeometry(android).resolve(tree, { x: 22, y: 44 }).point).toEqual({
      x: 22,
      y: 44,
    });
  });

  test("combines percent, center, and end offsets relative to an element", () => {
    const geometry = new CoordinateGeometry(android);
    const target = { relativeTo: { elementId: "canvas" } };
    expect(
      geometry.resolve(hierarchy(), {
        ...target,
        x: { value: 22, unit: "percent" },
        y: { value: 10, from: "end" },
      }).point,
    ).toEqual({ x: 144, y: 390 });
    expect(
      geometry.resolve(hierarchy(), {
        ...target,
        x: { value: -10, from: "center" },
        y: 10,
      }).point,
    ).toEqual({ x: 190, y: 210 });
  });

  test("uses iOS nativeScale rather than screenScale for physical pixels", () => {
    expect(
      new CoordinateGeometry(ios).resolve(
        { ...hierarchy(), screenScale: 2 },
        {
          x: { value: 300, unit: "pixels" },
          y: { value: 600, unit: "pixels" },
        },
      ),
    ).toMatchObject({ point: { x: 100, y: 200 }, unit: "points" });
  });

  test("preserves fractional iOS points", () => {
    expect(new CoordinateGeometry(ios).resolve(hierarchy(), { x: 1.25, y: 3.5 }).point).toEqual({
      x: 1.25,
      y: 3.5,
    });
  });

  test.each([-1, 400, Infinity, NaN])("rejects invalid screen x=%s without clamping", (x) => {
    expect(() => new CoordinateGeometry(android).resolve(hierarchy(), { x, y: 20 })).toThrow();
  });

  test("rejects points on Android and unknown physical scaling on iOS", () => {
    expect(() =>
      new CoordinateGeometry(android).resolve(hierarchy(), {
        x: { value: 1, unit: "points" },
        y: 1,
      }),
    ).toThrow("only supported on iOS");
    expect(() =>
      new CoordinateGeometry(ios).resolve(
        { ...hierarchy(), nativeScale: undefined },
        {
          x: { value: 1, unit: "pixels" },
          y: 1,
        },
      ),
    ).toThrow("scale is unavailable");
  });

  test("rejects missing and ambiguous element IDs", () => {
    const geometry = new CoordinateGeometry(android);
    expect(() =>
      geometry.resolve(hierarchy(), { relativeTo: { elementId: "missing" }, x: 1, y: 1 }),
    ).toThrow("found 0");
    const tree = hierarchy();
    tree.hierarchy.node = node("root", [node("duplicate"), node("duplicate")]);
    expect(() =>
      geometry.resolve(tree, { relativeTo: { elementId: "duplicate" }, x: 1, y: 1 }),
    ).toThrow("found 2");
  });

  test("half-open reference bounds exclude the bottom/right edge", () => {
    expect(() =>
      new CoordinateGeometry(android).resolve(hierarchy(), {
        relativeTo: { elementId: "canvas" },
        x: 200,
        y: 1,
      }),
    ).toThrow("outside");
  });

  test("hitTest reports nested candidates and no dispatch guarantee", () => {
    const tree = hierarchy();
    tree.hierarchy.node = node("canvas", [node("label")]);
    const result = new CoordinateGeometry(android).hitTest(tree, { x: 150, y: 250 });
    expect(result.element?.elementId).toBe("label");
    expect(result.candidates.map((e) => e.elementId)).toEqual(["label", "canvas"]);
    expect(result.dispatchGuaranteed).toBe(false);
    expect(result.method).toBe("hierarchy-bounds");
  });

  test("hitTest puts the topmost window before deeper nodes behind it", () => {
    const tree = hierarchy();
    tree.windows = [
      { windowLayer: 1, hierarchy: node("background", [node("background-child")]) },
      { windowLayer: 5, hierarchy: node("dialog") },
    ];
    expect(
      new CoordinateGeometry(android).hitTest(tree, { x: 150, y: 250 }).element?.elementId,
    ).toBe("dialog");
  });

  test("hitTest can return no candidates for an in-bounds custom-drawn area", () => {
    expect(new CoordinateGeometry(android).hitTest(hierarchy(), { x: 1, y: 1 }).element).toBeNull();
  });

  test("rejects invalid screen geometry", () => {
    expect(() =>
      new CoordinateGeometry(android).resolve({ ...hierarchy(), screenWidth: 0 }, { x: 0, y: 0 }),
    ).toThrow("unavailable");
  });
});

describe("snapshot coordinate references", () => {
  const frame: CoordinateSnapshotFrame = {
    deviceId: ios.deviceId,
    platform: ios.platform,
    elementId: "canvas",
    elementBounds: bounds,
    screenSize: { width: 400, height: 800 },
    rotation: 0,
    bounds,
    pixelsPerUnit: { x: 3, y: 3 },
    nativeScale: 3,
  };

  test("uses crop pixels by default and rejects an expired reference", () => {
    const timer = new FakeTimer();
    const frames = createSnapshotFrameStore(timer);
    frames.set("snapshot", frame);
    const geometry = new CoordinateGeometry(ios, frames);
    const target = { relativeTo: { snapshotId: "snapshot" }, x: 30, y: 60 };
    expect(geometry.resolve(hierarchy(), target).point).toEqual({ x: 110, y: 220 });
    timer.advanceTime(SNAPSHOT_FRAME_TTL_MS);
    expect(() => geometry.resolve(hierarchy(), target)).toThrow("expired");
  });

  test("rejects cross-device references and moved elements", () => {
    const frames = createSnapshotFrameStore(new FakeTimer());
    frames.set("snapshot", frame);
    const target = { relativeTo: { snapshotId: "snapshot" }, x: 3, y: 3 };
    expect(() => new CoordinateGeometry(android, frames).resolve(hierarchy(), target)).toThrow(
      "another device",
    );
    const tree = hierarchy();
    tree.hierarchy.node = { $: { "resource-id": "canvas", bounds: { ...bounds, top: 210 } } };
    expect(() => new CoordinateGeometry(ios, frames).resolve(tree, target)).toThrow(
      "geometry has changed",
    );
  });

  test("rejects rotation changes even when dimensions are unchanged", () => {
    const frames = createSnapshotFrameStore(new FakeTimer());
    frames.set("snapshot", frame);
    expect(() =>
      new CoordinateGeometry(ios, frames).resolve(
        { ...hierarchy(), rotation: 2 },
        {
          relativeTo: { snapshotId: "snapshot" },
          x: 30,
          y: 60,
        },
      ),
    ).toThrow("geometry has changed");
  });
});
