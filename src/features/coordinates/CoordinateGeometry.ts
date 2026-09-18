import type {
  BootedDevice,
  Element,
  ElementBounds,
  ScreenSize,
  ViewHierarchyResult,
} from "../../models";
import { ActionableError } from "../../models";
import { isFalsy, isTruthy } from "../../models/Element";
import { boundsEqual, boundsArea } from "../../utils/bounds";
import { TTLCache } from "../../utils/cache/Cache";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";

export interface CoordinateAxis {
  value: number;
  unit?: "native" | "pixels" | "points" | "percent";
  /** Positive offsets from end move inward; center offsets are signed. */
  from?: "start" | "center" | "end";
}

export type CoordinateReference = { elementId: string } | { snapshotId: string };

export interface CoordinateTarget {
  x: number | CoordinateAxis;
  y: number | CoordinateAxis;
  relativeTo?: CoordinateReference;
}

export interface CoordinateSnapshotFrame {
  deviceId: string;
  platform: BootedDevice["platform"];
  elementId: string;
  elementBounds: ElementBounds;
  screenSize: ScreenSize;
  rotation?: number;
  incarnation?: string;
  nativeScale?: number;
  /** Actual raster crop expressed in native screen coordinates. */
  bounds: ElementBounds;
  pixelsPerUnit: { x: number; y: number };
}

export interface SnapshotFrameStore {
  get(id: string): CoordinateSnapshotFrame | undefined;
  set(id: string, frame: CoordinateSnapshotFrame): void;
}

export const SNAPSHOT_FRAME_TTL_MS = 5 * 60 * 1000;

// Reuse the bounded repository cache: frames contain geometry, never image bytes.
export function createSnapshotFrameStore(timer: Timer = defaultTimer): SnapshotFrameStore {
  return new TTLCache<string, CoordinateSnapshotFrame>(timer, {
    ttlMs: SNAPSHOT_FRAME_TTL_MS,
    maxEntries: 100,
  });
}

export const coordinateSnapshotFrames = createSnapshotFrameStore();

export interface CoordinateGeometryResult {
  point: { x: number; y: number };
  unit: "pixels" | "points";
  screenSize: ScreenSize;
  reference: {
    bounds: ElementBounds;
    elementId?: string;
    snapshotId?: string;
  };
  frameContext?: string;
}

export interface CoordinateElement {
  elementId?: string;
  text?: string;
  className?: string;
  bounds: ElementBounds;
  width: number;
  height: number;
  clickable: boolean;
  enabled: boolean;
}

function validBounds(bounds: ElementBounds): boolean {
  return (
    Object.values(bounds).every(Number.isFinite) &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top
  );
}

function contains(bounds: ElementBounds, x: number, y: number): boolean {
  return (
    validBounds(bounds) &&
    x >= bounds.left &&
    x < bounds.right &&
    y >= bounds.top &&
    y < bounds.bottom
  );
}

export function describeCoordinateElement(element: Element): CoordinateElement {
  return {
    elementId: element["resource-id"] || element["view-id"] || undefined,
    text: element.text || element["content-desc"] || undefined,
    className: element.class,
    bounds: element.bounds,
    width: element.bounds.right - element.bounds.left,
    height: element.bounds.bottom - element.bounds.top,
    clickable: isTruthy(element.clickable),
    enabled: !isFalsy(element.enabled),
  };
}

/** Shared native-coordinate resolution for tapAt, hitTest, and snapshotOf. */
export class CoordinateGeometry {
  constructor(
    private readonly device: BootedDevice,
    private readonly frames: SnapshotFrameStore = coordinateSnapshotFrames,
    private readonly finder: ElementFinder = new DefaultElementFinder(),
    private readonly parser: ElementParser = new DefaultElementParser(),
  ) {}

  validateSnapshot(hierarchy: ViewHierarchyResult, id: string): CoordinateSnapshotFrame {
    const frame = this.frames.get(id);
    if (
      !frame ||
      frame.deviceId !== this.device.deviceId ||
      frame.platform !== this.device.platform ||
      frame.incarnation !== deviceIncarnationToken(this.device.deviceId)
    ) {
      throw new ActionableError(
        "Snapshot is expired, unknown, or belongs to another device. Call snapshotOf again.",
      );
    }
    const screen = this.screenSize(hierarchy);
    if (
      !boundsEqual(this.element(hierarchy, frame.elementId).bounds, frame.elementBounds) ||
      screen.width !== frame.screenSize.width ||
      screen.height !== frame.screenSize.height ||
      hierarchy.rotation !== frame.rotation ||
      hierarchy.nativeScale !== frame.nativeScale
    ) {
      throw new ActionableError("Snapshot geometry has changed. Call snapshotOf again.");
    }
    return frame;
  }

  screenSize(hierarchy: ViewHierarchyResult): ScreenSize {
    const width = hierarchy.screenWidth;
    const height = hierarchy.screenHeight;
    if (
      !width ||
      !height ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new ActionableError(
        "Current screen geometry is unavailable; observe the device again.",
      );
    }
    return { width, height };
  }

  element(hierarchy: ViewHierarchyResult, elementId: string): Element {
    const matches = this.finder.findElementsByResourceId(hierarchy, elementId);
    if (matches.length !== 1) {
      throw new ActionableError(
        `Expected one element for "${elementId}", found ${matches.length}. Use a unique elementId from observe.`,
      );
    }
    const element = matches[0];
    if (
      !validBounds(element.bounds) ||
      isFalsy(element["visible-to-user"]) ||
      isFalsy(element.visible)
    ) {
      throw new ActionableError(`Element "${elementId}" has no visible bounds.`);
    }
    return element;
  }

  resolve(hierarchy: ViewHierarchyResult, target: CoordinateTarget): CoordinateGeometryResult {
    const screenSize = this.screenSize(hierarchy);
    let bounds: ElementBounds = {
      left: 0,
      top: 0,
      right: screenSize.width,
      bottom: screenSize.height,
    };
    let elementId: string | undefined;
    let snapshotId: string | undefined;
    let snapshot: CoordinateSnapshotFrame | undefined;
    if (target.relativeTo && "snapshotId" in target.relativeTo) {
      snapshotId = target.relativeTo.snapshotId;
      snapshot = this.validateSnapshot(hierarchy, snapshotId);
      elementId = snapshot.elementId;
      bounds = snapshot.bounds;
    } else if (target.relativeTo && "elementId" in target.relativeTo) {
      elementId = target.relativeTo.elementId;
      bounds = this.element(hierarchy, elementId).bounds;
    }
    const x = this.axis(target.x, bounds.left, bounds.right, hierarchy, snapshot, "x");
    const y = this.axis(target.y, bounds.top, bounds.bottom, hierarchy, snapshot, "y");
    if (
      !contains(bounds, x, y) ||
      !contains({ left: 0, top: 0, right: screenSize.width, bottom: screenSize.height }, x, y) ||
      (snapshot !== undefined && !contains(snapshot.elementBounds, x, y))
    ) {
      throw new ActionableError(
        "Coordinates are outside the reference or visible screen; coordinates are never clamped.",
      );
    }
    return {
      point: { x, y },
      unit: this.device.platform === "ios" ? "points" : "pixels",
      screenSize,
      reference: { bounds, elementId, snapshotId },
      frameContext: hierarchy.frameContext,
    };
  }

  private axis(
    input: number | CoordinateAxis,
    start: number,
    end: number,
    hierarchy: ViewHierarchyResult,
    snapshot: CoordinateSnapshotFrame | undefined,
    axis: "x" | "y",
  ): number {
    const spec = typeof input === "number" ? { value: input } : input;
    const unit = spec.unit ?? (snapshot ? "pixels" : "native");
    let value = spec.value;
    if (!Number.isFinite(value)) {
      throw new ActionableError("Coordinates must be finite numbers.");
    }
    if (unit === "percent") {
      value = (value / 100) * (end - start);
    } else if (unit === "points" && this.device.platform !== "ios") {
      throw new ActionableError(
        "points are only supported on iOS; use native or pixels on Android.",
      );
    } else if (unit === "pixels") {
      value /= this.pixelScale(hierarchy, snapshot, axis);
    }
    if (spec.from === "end") {
      return end - value;
    }
    return (spec.from === "center" ? (start + end) / 2 : start) + value;
  }

  private pixelScale(
    hierarchy: ViewHierarchyResult,
    snapshot: CoordinateSnapshotFrame | undefined,
    axis: "x" | "y",
  ): number {
    const scale =
      snapshot?.pixelsPerUnit[axis] ??
      (this.device.platform === "android" ? 1 : hierarchy.nativeScale);
    if (!scale || !Number.isFinite(scale) || scale <= 0) {
      throw new ActionableError(
        "Physical pixel scale is unavailable. Use native coordinates or a snapshotOf reference.",
      );
    }
    return scale;
  }

  hitTest(hierarchy: ViewHierarchyResult, target: CoordinateTarget) {
    const geometry = this.resolve(hierarchy, target);
    const groups = (hierarchy.windows ?? [])
      .filter((window) => window.hierarchy)
      .sort((a, b) => (b.windowLayer ?? 0) - (a.windowLayer ?? 0))
      .map((window) => [window.hierarchy!]);
    // Window trees supersede the duplicated primary tree where available.
    const roots = groups.length ? groups : [this.parser.extractRootNodes(hierarchy)];
    const candidates: Array<{ element: Element; depth: number; windowOrder: number }> = [];
    roots.forEach((group, windowOrder) => {
      for (const root of group) {
        this.parser.traverseNode(root, (node, depth) => {
          const element = this.parser.parseNodeBounds(node);
          if (
            element &&
            !isFalsy(element["visible-to-user"]) &&
            !isFalsy(element.visible) &&
            element.occlusionState !== "hidden" &&
            contains(element.bounds, geometry.point.x, geometry.point.y)
          ) {
            candidates.push({ element, depth, windowOrder });
          }
        });
      }
    });
    candidates.sort(
      (a, b) =>
        a.windowOrder - b.windowOrder ||
        b.depth - a.depth ||
        boundsArea(a.element.bounds) - boundsArea(b.element.bounds),
    );
    const elements = candidates
      .slice(0, 25)
      .map(({ element }) => describeCoordinateElement(element));
    return {
      success: true as const,
      ...geometry,
      method: "hierarchy-bounds" as const,
      dispatchGuaranteed: false as const,
      element: elements[0] ?? null,
      candidates: elements,
      truncated: candidates.length > elements.length,
      warning:
        "Geometric candidates only. Native touch interception, sibling z-order, custom drawing, and screen readers can change which control receives a tap.",
    };
  }
}
