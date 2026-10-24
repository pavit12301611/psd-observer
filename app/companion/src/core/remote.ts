/**
 * Screen-view maths for the PC control page.
 *
 * Everything here is pure so it can be tested without a browser: the phone
 * shows a screenshot that may be a *crop* of the PC screen (when zoomed), so a
 * tap has to travel back through the crop before it becomes a PC coordinate.
 */

export type Region = {
  /** 0-1000 normalised coordinates of the PC screen. */
  x: number;
  y: number;
  w: number;
  h: number;
};
export type Center = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Keeps the requested centre inside the bounds implied by the zoom level. */
export function clampCenter(zoom: number, center: Center): Center {
  const half = 1 / (2 * clampZoom(zoom));
  return {
    x: Math.min(1 - half, Math.max(half, center.x)),
    y: Math.min(1 - half, Math.max(half, center.y)),
  };
}

/** The part of the screen the phone is looking at, in 0-1000 units. */
export function visibleRegion(zoom: number, center: Center): Region {
  const z = clampZoom(zoom),
    c = clampCenter(z, center),
    size = 1000 / z;
  return {
    x: Math.round((c.x * 1000 - size / 2) * 1000) / 1000,
    y: Math.round((c.y * 1000 - size / 2) * 1000) / 1000,
    w: Math.round(size * 1000) / 1000,
    h: Math.round(size * 1000) / 1000,
  };
}

/** Query string for a frame request; a full view asks for no crop at all. */
export function frameQuery(options: {
  zoom: number;
  center: Center;
  width: number;
}): string {
  const base = `?w=${Math.round(options.width)}`;
  if (clampZoom(options.zoom) <= MIN_ZOOM) return base;
  const r = visibleRegion(options.zoom, options.center);
  return `${base}&cx=${r.x}&cy=${r.y}&cw=${r.w}&ch=${r.h}`;
}

/**
 * Maps a touch to a PC coordinate.
 *
 * `region` is what the visible image represents. The image is letterboxed with
 * `object-fit: contain`, so pixels outside the drawn image are ignored instead
 * of clicking whatever happens to be at that screen position.
 */
export function pointToScreen(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
  region: Region = { x: 0, y: 0, w: 1000, h: 1000 },
): { x: number; y: number; relative: true } | null {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    natural.width <= 0 ||
    natural.height <= 0
  )
    return null;
  const scale = Math.min(
      rect.width / natural.width,
      rect.height / natural.height,
    ),
    drawnWidth = natural.width * scale,
    drawnHeight = natural.height * scale;
  const localX = clientX - rect.left - (rect.width - drawnWidth) / 2,
    localY = clientY - rect.top - (rect.height - drawnHeight) / 2;
  if (localX < 0 || localY < 0 || localX >= drawnWidth || localY >= drawnHeight)
    return null;
  const fx = clamp01(localX / drawnWidth),
    fy = clamp01(localY / drawnHeight);
  return {
    x: Math.min(999, Math.max(0, Math.round(region.x + fx * region.w))),
    y: Math.min(999, Math.max(0, Math.round(region.y + fy * region.h))),
    relative: true,
  };
}

/** Centre after dragging the image by a fraction of its size. */
export function panCenter(
  zoom: number,
  center: Center,
  dxFraction: number,
  dyFraction: number,
): Center {
  const z = clampZoom(zoom);
  return clampCenter(z, {
    x: center.x - dxFraction / z,
    y: center.y - dyFraction / z,
  });
}

/** Zoom while keeping the pixel under the pinch midpoint where it was. */
export function zoomAround(
  fromZoom: number,
  center: Center,
  nextZoom: number,
  anchor: { x: number; y: number },
): { zoom: number; center: Center } {
  const zoom = clampZoom(nextZoom),
    before = clampCenter(fromZoom, center),
    // Anchor in screen space (0-1), then the same point after zooming.
    ax = before.x + (anchor.x - 0.5) / clampZoom(fromZoom),
    ay = before.y + (anchor.y - 0.5) / clampZoom(fromZoom);
  return {
    zoom,
    center: clampCenter(zoom, {
      x: ax - (anchor.x - 0.5) / zoom,
      y: ay - (anchor.y - 0.5) / zoom,
    }),
  };
}

/** Backoff for repeated frame failures: fast first retry, then slow down. */
export function retryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(8000, 1200 * 2 ** Math.min(3, failures - 1));
}

/**
 * The pointer problem.
 *
 * On GNOME Wayland the only screenshots that work come from the portal, and the
 * portal never draws the mouse pointer. The PC reports its real screen size in
 * the frame headers, so the app can keep its own marker: absolute on a tap or a
 * drag (the PC told us those pixels), relative on trackpad/nudge moves (those are
 * PC pixels too). Nobody has to guess what "hidden" means — the owner sees where
 * their input landed.
 */
export function moveCursorBy(
  cursor: Center | null,
  dxPixels: number,
  dyPixels: number,
  screen: Size | null,
): Center | null {
  if (!cursor || !screen || screen.width <= 0 || screen.height <= 0) return null;
  if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) return null;
  return {
    x: Math.min(1000, Math.max(0, cursor.x + (dxPixels / screen.width) * 1000)),
    y: Math.min(1000, Math.max(0, cursor.y + (dyPixels / screen.height) * 1000)),
  };
}

/**
 * Where to draw the marker inside the stage: the image is letterboxed with
 * `object-fit: contain` and may be a crop of the screen, so both mappings have
 * to be undone. `null` means the point is outside the visible region.
 */
export function cursorMarkerPosition(
  cursor: Center | null,
  rect: Rect,
  natural: Size,
  region: Region = { x: 0, y: 0, w: 1000, h: 1000 },
): { x: number; y: number } | null {
  if (!cursor) return null;
  if (rect.width <= 0 || rect.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
  const fx = (cursor.x - region.x) / (region.w || 1),
    fy = (cursor.y - region.y) / (region.h || 1);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const scale = Math.min(rect.width / natural.width, rect.height / natural.height),
    drawnWidth = natural.width * scale,
    drawnHeight = natural.height * scale;
  return {
    x: (rect.width - drawnWidth) / 2 + fx * drawnWidth,
    y: (rect.height - drawnHeight) / 2 + fy * drawnHeight,
  };
}
