import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import { ToolRegistry } from "./toolRegistry";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  responseShapeControlFields,
} from "./toolSchemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import { CoordinateGeometry } from "../features/coordinates/CoordinateGeometry";
import { SnapshotOf } from "../features/coordinates/SnapshotOf";
import { TapAt, assertCoordinateHierarchy } from "../features/action/TapAt";
import { observationOutputSchema, elementBoundsSchema } from "./toolOutputSchemas";

const axisSchema = z
  .union([
    z.number(),
    z
      .object({
        value: z.number(),
        unit: z.enum(["native", "pixels", "points", "percent"]).optional(),
        from: z.enum(["start", "center", "end"]).optional(),
      })
      .strict(),
  ])
  .describe(
    "Number in native units (Android pixels/iOS points), or value with unit and origin. Snapshot numbers are crop pixels. End offsets move inward.",
  );

const coordinateFields = {
  x: axisSchema,
  y: axisSchema,
  relativeTo: z
    .union([
      z.object({ elementId: z.string().min(1) }).strict(),
      z.object({ snapshotId: z.string().min(1) }).strict(),
    ])
    .optional()
    .describe("Default: screen. Use a unique observe elementId or snapshotOf snapshotId."),
  platform: platformSchema.optional(),
};

export const hitTestSchema = addDeviceTargetingToSchema(z.object(coordinateFields).strict());
export const tapAtSchema = addDeviceTargetingToSchema(
  z
    .object({
      ...coordinateFields,
      ...responseShapeControlFields,
    })
    .strict(),
);
export const snapshotOfSchema = addDeviceTargetingToSchema(
  z
    .object({
      elementId: z
        .string()
        .min(1)
        .describe("Unique resource ID or stable element ID from observe."),
      includeImage: z
        .boolean()
        .optional()
        .describe("Return inline PNG as well as saved path (default true)."),
      platform: platformSchema.optional(),
    })
    .strict(),
);

const sizeSchema = z.object({ width: z.number().positive(), height: z.number().positive() });
const elementSchema = z.object({
  elementId: z.string().optional(),
  text: z.string().optional(),
  className: z.string().optional(),
  bounds: elementBoundsSchema,
  width: z.number(),
  height: z.number(),
  clickable: z.boolean(),
  enabled: z.boolean(),
});
const geometryFields = {
  point: z.object({ x: z.number(), y: z.number() }),
  unit: z.enum(["pixels", "points"]),
  screenSize: sizeSchema,
  reference: z.object({
    bounds: elementBoundsSchema,
    elementId: z.string().optional(),
    snapshotId: z.string().optional(),
  }),
  frameContext: z.string().optional(),
};
export const hitTestResultSchema = z.object({
  success: z.literal(true),
  ...geometryFields,
  method: z.literal("hierarchy-bounds"),
  dispatchGuaranteed: z.literal(false),
  element: elementSchema.nullable(),
  candidates: z.array(elementSchema),
  truncated: z.boolean(),
  warning: z.string(),
});
export const snapshotOfResultSchema = z.object({
  success: z.literal(true),
  element: elementSchema,
  unit: z.enum(["pixels", "points"]),
  screenSize: sizeSchema,
  relativeTo: z.object({ snapshotId: z.string() }),
  snapshot: z.object({
    snapshotId: z.string(),
    path: z.string(),
    mimeType: z.literal("image/png"),
    width: z.number(),
    height: z.number(),
    bounds: elementBoundsSchema,
    pixelsPerUnit: z.object({ x: z.number(), y: z.number() }),
    capturedAt: z.number(),
    expiresAt: z.number(),
    clipped: z.boolean(),
  }),
});
const tapAtResultSchema = z
  .object({
    success: z.boolean(),
    ...geometryFields,
    message: z.string(),
    observation: observationOutputSchema.optional(),
  })
  .passthrough();

export interface CoordinateToolDependencies {
  observer(device: BootedDevice): ObserveScreen;
  geometry(device: BootedDevice): CoordinateGeometry;
  snapshot(device: BootedDevice): Pick<SnapshotOf, "execute">;
  tap(device: BootedDevice): Pick<TapAt, "execute">;
}

export function registerCoordinateTools(
  deps: CoordinateToolDependencies = {
    observer: (device) => new RealObserveScreen(device),
    geometry: (device) => new CoordinateGeometry(device),
    snapshot: (device) => new SnapshotOf(device),
    tap: (device) => new TapAt(device),
  },
) {
  const read = async (device: BootedDevice, signal?: AbortSignal) => {
    const observation = await deps.observer(device).execute({
      skipWaitForFresh: false,
      skipScreenshot: true,
      skipBackStack: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
      signal,
    });
    assertCoordinateHierarchy(observation.viewHierarchy, observation.freshness?.isFresh);
    return observation.viewHierarchy;
  };
  ToolRegistry.registerDeviceAware(
    "tapAt",
    "Tap at screen, element, or snapshot coordinates. Dispatches once; use hitTest to preview.",
    tapAtSchema,
    async (device, args, progress, signal) =>
      createStructuredToolResponse(await deps.tap(device).execute(args, progress, signal)),
    { defaultEnabled: true, supportsProgress: true, outputSchema: tapAtResultSchema },
  );
  ToolRegistry.registerDeviceAware(
    "hitTest",
    "Preview coordinate geometry and containing elements without tapping. Bounds estimate, not native dispatch.",
    hitTestSchema,
    async (device, args, _progress, signal) =>
      createStructuredToolResponse(deps.geometry(device).hitTest(await read(device, signal), args)),
    { defaultEnabled: true, outputSchema: hitTestResultSchema },
  );
  ToolRegistry.registerDeviceAware(
    "snapshotOf",
    "Crop a visible element to PNG with geometry and a reusable snapshot coordinate reference.",
    snapshotOfSchema,
    async (device, args, _progress, signal) => {
      const result = await deps
        .snapshot(device)
        .execute(await read(device, signal), args.elementId, signal);
      // Screenshots and hierarchy reads are separate platform operations. Reject
      // an element that moved while the raster was captured/encoded.
      deps
        .geometry(device)
        .validateSnapshot(await read(device, signal), result.payload.snapshot.snapshotId);
      const response = createStructuredToolResponse(result.payload);
      return {
        ...response,
        content: [
          ...response.content,
          ...(args.includeImage === false
            ? []
            : [
                {
                  type: "image" as const,
                  data: result.png.toString("base64"),
                  mimeType: "image/png",
                },
              ]),
        ],
      };
    },
    { defaultEnabled: true, outputSchema: snapshotOfResultSchema },
  );
}
