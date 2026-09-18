import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { TapAt, type CoordinateTapper } from "../../../src/features/action/TapAt";
import { CoordinateGeometry } from "../../../src/features/coordinates/CoordinateGeometry";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeWindow } from "../../fakes/FakeWindow";
import type { Window } from "../../../src/features/observe/Window";
import { PortManager } from "../../../src/utils/PortManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";

const device: BootedDevice = { name: "test", deviceId: "test-ios", platform: "ios" };

class FakeCoordinateTapper implements CoordinateTapper {
  calls: Array<{ x: number; y: number; frameContext?: string }> = [];
  success = true;
  async tap(x: number, y: number, frameContext?: string) {
    this.calls.push({ x, y, frameContext });
    return { success: this.success, error: "gesture rejected" };
  }
}

function setup() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observer = new FakeObserveScreen();
  const observation: ObserveResult = {
    observationId: "test",
    screenSize: { width: 400, height: 800 },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            "resource-id": "canvas",
            bounds: { left: 10, top: 20, right: 110, bottom: 120 },
          },
        },
      },
      screenWidth: 400,
      screenHeight: 800,
      fresh: true,
      frameContext: "fresh-frame",
    },
  };
  observer.setObserveResult(observation);
  const tapper = new FakeCoordinateTapper();
  const action = new TapAt(
    device,
    new CoordinateGeometry(device),
    tapper,
    timer,
    new FakeAdbClient(),
  );
  action.observeScreen = observer;
  // BaseVisualChange currently types this seam as the concrete Window.
  action.window = new FakeWindow() as Window;
  return { action, observer, observation, tapper };
}

describe("TapAt", () => {
  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });
  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });
  test("dispatches exactly once using freshly resolved element coordinates and frame identity", async () => {
    const { action, observer, tapper } = setup();
    const result = await action.execute({ relativeTo: { elementId: "canvas" }, x: 15, y: 30 });
    expect(result.success).toBe(true);
    expect(tapper.calls).toEqual([{ x: 25, y: 50, frameContext: "fresh-frame" }]);
    expect(observer.getExecuteOptions()[0]).toMatchObject({ skipWaitForFresh: false });
  });

  test("invalid coordinates cannot dispatch a gesture", async () => {
    const { action, tapper } = setup();
    await expect(action.execute({ x: 400, y: 20 })).rejects.toThrow("outside");
    expect(tapper.calls).toEqual([]);
  });

  test("a failed acknowledgement is propagated without retrying", async () => {
    const { action, tapper } = setup();
    tapper.success = false;
    await expect(action.execute({ x: 10, y: 20 })).rejects.toThrow("gesture rejected");
    expect(tapper.calls).toHaveLength(1);
  });

  test("pre-dispatch cancellation never taps", async () => {
    const { action, tapper } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(action.execute({ x: 10, y: 20 }, undefined, controller.signal)).rejects.toThrow();
    expect(tapper.calls).toEqual([]);
  });

  test("stale geometry cannot dispatch", async () => {
    const { action, observation, tapper } = setup();
    observation.viewHierarchy!.fresh = false;
    await expect(action.execute({ x: 10, y: 20 })).rejects.toThrow("fresh hierarchy");
    expect(tapper.calls).toEqual([]);
  });

  test("a fresh tree with stale foreground identity cannot dispatch", async () => {
    const { action, observation, tapper } = setup();
    observation.freshness = { isFresh: false };
    await expect(action.execute({ x: 10, y: 20 })).rejects.toThrow("fresh hierarchy");
    expect(tapper.calls).toEqual([]);
  });
});
