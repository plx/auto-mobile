import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models";
import type { ScreenshotService } from "../observe/interfaces/ScreenshotService";
import type { ImageUtils } from "../../utils/interfaces/ImageUtils";
import { JimpImageUtils } from "../../utils/image-utils";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { TakeScreenshot } from "../observe/TakeScreenshot";
import {
  defaultScreenshotFileWriter,
  type ScreenshotFileWriter,
} from "../observe/screenshot/ScreenshotFileWriter";
import {
  CoordinateGeometry,
  coordinateSnapshotFrames,
  describeCoordinateElement,
  SNAPSHOT_FRAME_TTL_MS,
  type SnapshotFrameStore,
} from "./CoordinateGeometry";

export interface SnapshotOfDependencies {
  screenshot: ScreenshotService;
  images: ImageUtils;
  read: (path: string) => Promise<Buffer>;
  writer: ScreenshotFileWriter;
  frames: SnapshotFrameStore;
  timer: Timer;
  ids: IdGenerator;
}

export class SnapshotOf {
  private readonly deps: SnapshotOfDependencies;

  constructor(
    private readonly device: BootedDevice,
    dependencies?: SnapshotOfDependencies,
  ) {
    if (dependencies) {
      this.deps = dependencies;
      return;
    }
    this.deps = {
      screenshot: new TakeScreenshot(device),
      images: new JimpImageUtils(),
      read: readFile,
      writer: defaultScreenshotFileWriter,
      frames: coordinateSnapshotFrames,
      timer: defaultTimer,
      ids: defaultIdGenerator,
    };
  }

  async execute(hierarchy: ViewHierarchyResult, elementId: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const geometry = new CoordinateGeometry(this.device, this.deps.frames);
    const screenSize = geometry.screenSize(hierarchy);
    const element = geometry.element(hierarchy, elementId);
    const b = element.bounds;
    if (b.right <= 0 || b.bottom <= 0 || b.left >= screenSize.width || b.top >= screenSize.height) {
      throw new ActionableError("Element is off screen; scroll it into view before snapshotOf.");
    }
    const screenshot = await this.readCapture(signal);
    const image = screenshot.image;
    const metadata = await this.deps.images.getMetadata(image);
    const scale = { x: metadata.width / screenSize.width, y: metadata.height / screenSize.height };
    // An orientation change between the hierarchy and raster must not produce a misleading crop.
    this.validateScale(scale);
    const left = Math.max(0, Math.floor(b.left * scale.x));
    const top = Math.max(0, Math.floor(b.top * scale.y));
    const right = Math.min(metadata.width, Math.ceil(b.right * scale.x));
    const bottom = Math.min(metadata.height, Math.ceil(b.bottom * scale.y));
    const width = right - left;
    const height = bottom - top;
    const cropped = await this.deps.images.crop(image, width, height, left, top);
    const png = await this.deps.images.toPng(cropped);
    throwIfAborted(signal);
    // A separate prefix avoids treating a crop as the latest full-screen capture.
    const snapshotPath = path.join(
      path.dirname(screenshot.path),
      `element-${this.deps.ids.next()}.png`,
    );
    await this.deps.writer.write(snapshotPath, png);
    if (signal?.aborted) {
      await this.deps.writer.remove(snapshotPath);
      throwIfAborted(signal);
    }
    const snapshotId = this.deps.ids.next();
    const capturedAt = this.deps.timer.now();
    const bounds = {
      left: left / scale.x,
      top: top / scale.y,
      right: right / scale.x,
      bottom: bottom / scale.y,
    };
    this.deps.frames.set(snapshotId, {
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      elementId,
      elementBounds: { ...b },
      screenSize,
      rotation: hierarchy.rotation,
      incarnation: deviceIncarnationToken(this.device.deviceId),
      nativeScale: hierarchy.nativeScale,
      bounds,
      pixelsPerUnit: scale,
    });
    return {
      payload: {
        success: true as const,
        element: describeCoordinateElement(element),
        unit: this.device.platform === "ios" ? ("points" as const) : ("pixels" as const),
        screenSize,
        snapshot: {
          snapshotId,
          path: snapshotPath,
          mimeType: "image/png" as const,
          width,
          height,
          bounds,
          pixelsPerUnit: scale,
          capturedAt,
          expiresAt: capturedAt + SNAPSHOT_FRAME_TTL_MS,
          clipped:
            b.left < 0 || b.top < 0 || b.right > screenSize.width || b.bottom > screenSize.height,
        },
        relativeTo: { snapshotId },
      },
      png,
    };
  }

  private async readCapture(signal?: AbortSignal): Promise<{ path: string; image: Buffer }> {
    const result = await this.deps.screenshot.execute({ format: "png" }, signal);
    throwIfAborted(signal);
    if (!result.success || !result.path) {
      throw new ActionableError(`Screenshot capture failed: ${result.error}`);
    }
    return { path: result.path, image: await this.deps.read(result.path) };
  }

  private validateScale(scale: { x: number; y: number }): void {
    if (
      !Number.isFinite(scale.x) ||
      !Number.isFinite(scale.y) ||
      scale.x <= 0 ||
      scale.y <= 0 ||
      Math.abs(scale.x - scale.y) > Math.max(scale.x, scale.y) * 0.01
    ) {
      throw new ActionableError(
        "Screenshot and hierarchy geometry disagree; call snapshotOf again.",
      );
    }
  }
}
