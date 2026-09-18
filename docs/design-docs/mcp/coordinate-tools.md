# Coordinate interaction tools (draft)

`tapAt`, `snapshotOf`, and `hitTest` provide a visual escape hatch when a control
has no useful accessibility selector. Prefer semantic tools such as `tapOn`
when an appropriate selector exists. A custom canvas can expose just its outer
container: an agent can inspect that container and interact with a location
inside it without requiring each drawn control to be an accessibility node.

## Shared coordinates

`tapAt` and `hitTest` take exactly the same coordinate target:

```json
{
  "x": 120,
  "y": 240
}
```

The default reference is the whole screen, including system bars, with the
origin at its top-left. Numbers use the existing platform hierarchy units:
physical pixels on Android and logical points on iOS. Fractional values are
preserved. Each axis can independently specify a unit and origin:

```json
{
  "relativeTo": { "elementId": "canvas" },
  "x": { "value": 22, "unit": "percent" },
  "y": { "value": 12, "from": "end" }
}
```

This means 22% across the element, 12 native units above its bottom edge.

| Field        | Values                                  | Meaning                                  |
| ------------ | --------------------------------------- | ---------------------------------------- |
| `unit`       | `native`, `pixels`, `points`, `percent` | `points` is iOS-only; percent uses 0–100 |
| `from`       | `start`, `center`, `end`                | Left/top, center, right/bottom           |
| `relativeTo` | `{elementId}` or `{snapshotId}`         | Omit for screen coordinates              |

Positive offsets from `end` move inward; signed offsets from `center` move
right/down when positive. `start` and `native` are the ordinary defaults.
Physical edges are independent of language direction. RTL-aware
leading/trailing aliases are deferred pending agreement about their semantics.
Physical iOS pixels use `nativeScale`, never an assumed Retina scale or Android
density. Unknown scale is an error; native coordinates remain available.

Bounds are half-open: left/top inclusive, right/bottom exclusive. Invalid,
non-finite, off-screen, or out-of-reference points are rejected without
clamping. Missing or ambiguous element IDs are errors. Element references use
the existing resource-ID/stable-view-ID resolver, including its ambiguity
protections; they do not require a developer-authored accessibility ID.

## `snapshotOf`

```json
{ "elementId": "canvas" }
```

The response has JSON in both MCP `structuredContent` and a text content block,
plus an inline PNG image by default. `includeImage: false` omits the image block.
The JSON includes:

- `element`: ID, text/class when available, native screen bounds, width/height,
  and clickable/enabled attributes.
- `unit` and `screenSize`: the native coordinate system.
- `snapshot`: PNG path, pixel width/height, actual crop bounds in native screen
  coordinates, pixels per native unit, capture time, expiry time, and whether
  the element was clipped to the screen.
- `relativeTo: {snapshotId}`: ready to copy into either coordinate tool.

The path is on the MCP server's filesystem. Remote clients should use the
inline image. Files use the existing secure screenshot writer and screenshot
cache cleanup policy. The crop is named separately from full-screen captures,
so it cannot become a device's latest full-screen screenshot.

Screenshots are cropped without resizing. A partial element is clipped to the
screen; fractional bounds are rounded outward to raster edges. Snapshot
references retain the actual crop origin and scale, so no manual translation
is needed, even with clipping or Retina pixels. Pixels in outward-rounded
padding outside the original element are not valid tap targets.

Snapshot references expire after five minutes, are limited to 100 cached frames
per server process, and do not survive process restart. They are bound to the
device and its known connection incarnation. Before use, the tools re-resolve
the element and reject changed bounds, screen dimensions, rotation, or native
scale. `snapshotOf` also rechecks geometry after capturing the image.

## The three-tool loop

1. Obtain a parent/container ID from `observe` (use its full projection when
   the actionable skeleton omits the container).
2. Call `snapshotOf` and analyze its smaller image.
3. Pass the returned snapshot reference and crop-image coordinates to `hitTest`.
4. Inspect the resolved screen point and candidates, then pass the same
   coordinate arguments to `tapAt`.

For example, if the desired point is `(66, 90)` in the crop:

```json
{
  "relativeTo": { "snapshotId": "<returned snapshotId>" },
  "x": 66,
  "y": 90
}
```

With a snapshot reference, bare numbers default to **crop image pixels**.
Percentages and edge/center origins also work within the crop. Explicit
`unit: "native"` still means platform units.

## `hitTest`

`hitTest` reads current geometry and returns the same resolved point/reference
that `tapAt` will use, plus element descriptors in the same shape as
`snapshotOf.element`. It returns the first candidate as `element` (or `null`),
up to 25 `candidates`, and a truncation flag. Candidates are ordered by reported
window layer, then hierarchy depth and smaller bounds.

This draft implements a **hierarchy-bounds estimate**, exposed as
`method: "hierarchy-bounds"` and `dispatchGuaranteed: false`. It does not invoke
a gesture or an interaction-based performance audit. A canvas with no child
accessibility nodes can yield only its container; a valid screen point can have
no candidate. Disabled candidates are reported with `enabled: false`.

Native touch interception, sibling drawing order, transformed hit regions,
custom views, and TalkBack/VoiceOver behavior cannot be inferred reliably from
the accessibility hierarchy. A preview is not a promise that a native control
will receive the touch. Whether to add native platform hit-testing support is
an explicit design question for review.

## `tapAt`

`tapAt` resolves the target against a fresh observation immediately before
dispatch and sends exactly one coordinate gesture through the existing Android
or iOS CtrlProxy client. Available frame identity is forwarded to the runner.
It uses the existing post-action observation and response-projection machinery.
It never retargets an accessible ancestor or retries an acknowledged gesture.
An unavailable runner or rejected gesture is an error.

This is physical-coordinate input. Screen readers can interpret that input
differently from a semantic activation; use existing accessibility tools when
semantic activation is desired.

## Limits and review questions

- Capture, preview, and dispatch are separate operations. Geometry checks catch
  moved/resized references but cannot prove that unchanged geometry still
  displays the same content. Re-snapshot after navigation, scrolling, or
  animation; avoid treating a preview as a transaction.
- A crop contains the visible screen pixels in the element's rectangle,
  including any overlay. It is not an isolated render of an occluded view.
- Snapshot IDs are for an interactive session, not durable test-plan replay.
  Recorded automation should use screen/element coordinates or recapture first.
- This draft supports a single tap. Double taps, long presses, text selectors,
  arbitrary rectangular crops, and RTL aliases can be discussed separately.
- Live Android/iOS acceptance should cover a custom canvas, nested containers,
  overlapping windows, rotation, partial clipping, and Retina scaling before
  promoting the proposal out of draft.

The implementation uses the Node standard library and existing element parser,
finder, TTL cache, image backend, screenshot writer, gesture clients, and
observation workflow. It introduces no dependencies. Tests inject clocks,
images, capture/file I/O, observers, and gesture dispatch.
