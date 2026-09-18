import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models";
import { BaseVisualChange, type ProgressCallback } from "./BaseVisualChange";
import { CoordinateGeometry, type CoordinateTarget } from "../coordinates/CoordinateGeometry";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { throwIfAborted } from "../../utils/toolUtils";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export interface CoordinateTapper {
  tap(
    x: number,
    y: number,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }>;
}

export function createCoordinateTapper(device: BootedDevice): CoordinateTapper {
  return {
    tap: (x, y, frameContext, signal) => {
      throwIfAborted(signal);
      if (device.platform === "ios") {
        return IOSCtrlProxyClient.getInstance(device).requestTapCoordinates(
          x,
          y,
          50,
          undefined,
          undefined,
          frameContext,
          signal,
        );
      }
      return AndroidCtrlProxyClient.getInstance(device).requestTapCoordinates(
        x,
        y,
        10,
        undefined,
        undefined,
        frameContext,
      );
    },
  };
}

export class TapAt extends BaseVisualChange {
  constructor(
    device: BootedDevice,
    private readonly geometry = new CoordinateGeometry(device),
    private readonly tapper: CoordinateTapper = createCoordinateTapper(device),
    timer: Timer = defaultTimer,
    adb?: AdbExecutor,
  ) {
    super(device, adb, timer);
  }

  async execute(target: CoordinateTarget, progress?: ProgressCallback, signal?: AbortSignal) {
    return this.observedInteraction(
      async () => {
        // Resolve at dispatch time, including when actions-no-observe is enabled.
        const observation = await this.observeScreen.execute({
          skipWaitForFresh: false,
          skipScreenshot: true,
          skipBackStack: true,
          skipAccessibilityAudit: true,
          skipPerformanceAudit: true,
          skipRecompositionTracking: true,
          signal,
        });
        const hierarchy = observation.viewHierarchy;
        assertCoordinateHierarchy(hierarchy, observation.freshness?.isFresh);
        const resolved = this.geometry.resolve(hierarchy, target);
        throwIfAborted(signal);
        const result = await this.tapper.tap(
          resolved.point.x,
          resolved.point.y,
          hierarchy.frameContext,
          signal,
        );
        if (!result.success) {
          throw new ActionableError(result.error || "Coordinate tap failed.");
        }
        return { success: true, ...resolved, message: "Dispatched one coordinate tap." };
      },
      { changeExpected: false, skipPreviousObserve: true, progress, signal },
    );
  }
}

export function assertCoordinateHierarchy(
  hierarchy: ViewHierarchyResult | undefined,
  isFresh?: boolean,
): asserts hierarchy is ViewHierarchyResult {
  if (!hierarchy || hierarchy.hierarchy.error || hierarchy.fresh === false || isFresh === false) {
    throw new ActionableError("A fresh hierarchy is unavailable; observe the device and retry.");
  }
}
