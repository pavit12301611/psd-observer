import { describe, expect, it } from "vitest";
import {
  clampCenter,
  clampZoom,
  cursorMarkerPosition,
  frameQuery,
  moveCursorBy,
  pixelToUnit,
  MAX_ZOOM,
  panCenter,
  pointToScreen,
  retryDelay,
  visibleRegion,
  zoomAround,
} from "../src/core/remote";

describe("pc screen view", () => {
  it("only crops once the owner actually zoomed", () => {
    expect(frameQuery({ zoom: 1, center: { x: 0.5, y: 0.5 }, width: 1440 })).toBe(
      "?w=1440",
    );
    const zoomed = frameQuery({
      zoom: 2,
      center: { x: 0.5, y: 0.5 },
      width: 1440,
    });
    expect(zoomed).toBe("?w=1440&cx=250&cy=250&cw=500&ch=500");
    expect(frameQuery({ zoom: 99, center: { x: 0.5, y: 0.5 }, width: 960 })).toContain(
      "cw=250",
    );
  });

  it("keeps the viewport inside the screen at every zoom and pan", () => {
    for (const zoom of [1, 1.5, 2, 3, MAX_ZOOM, 0.2, Number.NaN]) {
      for (const center of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 0.5, y: 0.5 },
        { x: -3, y: 8 },
      ]) {
        const region = visibleRegion(zoom, center);
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
        expect(region.x + region.w).toBeLessThanOrEqual(1000.001);
        expect(region.y + region.h).toBeLessThanOrEqual(1000.001);
        expect(region.w).toBeGreaterThan(0);
        expect(clampZoom(zoom)).toBeGreaterThanOrEqual(1);
      }
    }
    expect(clampCenter(2, { x: 0, y: 0 })).toEqual({ x: 0.25, y: 0.25 });
  });

  it("maps a tap through the crop, and ignores letterbox padding", () => {
    const rect = { left: 10, top: 20, width: 300, height: 300 };
    const natural = { width: 400, height: 200 }; // 2:1 image letterboxed vertically
    // Centre of the drawn image is the centre of the screen.
    expect(pointToScreen(160, 170, rect, natural)).toEqual({
      x: 500,
      y: 500,
      relative: true,
    });
    // Top-left of the drawn image (height 150 inside 300 → 75px padding).
    expect(pointToScreen(10, 95, rect, natural)).toEqual({
      x: 0,
      y: 0,
      relative: true,
    });
    // In the letterbox above the image: not a click.
    expect(pointToScreen(160, 30, rect, natural)).toBeNull();
    // Zoomed crop: the same point maps into the region, not the whole screen.
    expect(
      pointToScreen(160, 170, rect, natural, { x: 500, y: 250, w: 500, h: 500 }),
    ).toEqual({ x: 750, y: 500, relative: true });
    expect(pointToScreen(0, 0, { ...rect, width: 0 }, natural)).toBeNull();
  });

  it("pans in the direction of the drag and stops at the edge", () => {
    expect(panCenter(2, { x: 0.5, y: 0.5 }, 0.1, 0)).toEqual({
      x: 0.45,
      y: 0.5,
    });
    expect(panCenter(2, { x: 0.5, y: 0.5 }, -5, -5)).toEqual({
      x: 0.75,
      y: 0.75,
    });
  });

  it("pinch zoom keeps the anchored pixel under the fingers", () => {
    const before = { zoom: 1, center: { x: 0.5, y: 0.5 } },
      anchor = { x: 0.75, y: 0.25 },
      after = zoomAround(before.zoom, before.center, 2, anchor);
    expect(after.zoom).toBe(2);
    // The anchor sits at the same screen-relative position after zooming.
    const screenX = after.center.x + (anchor.x - 0.5) / after.zoom,
      screenY = after.center.y + (anchor.y - 0.5) / after.zoom;
    expect(screenX).toBeCloseTo(0.75, 6);
    expect(screenY).toBeCloseTo(0.25, 6);
    expect(zoomAround(1, before.center, 0, anchor).zoom).toBe(1);
  });

  it("backs off after repeated frame failures but never gives up", () => {
    expect(retryDelay(0)).toBe(0);
    expect(retryDelay(1)).toBe(1200);
    expect(retryDelay(2)).toBe(2400);
    expect(retryDelay(3)).toBe(4800);
    expect(retryDelay(9)).toBe(8000);
  });
});

describe("pointer marker", () => {
  const screen = { width: 1920, height: 1080 };

  it("moves the marker by the same PC pixels the trackpad sends", () => {
    // 192 px across a 1920 px screen is exactly a tenth of the width.
    expect(moveCursorBy({ x: 500, y: 500 }, 192, -108, screen)).toEqual({
      x: 600,
      y: 400,
    });
    // Clamped, never off the screen or NaN.
    expect(moveCursorBy({ x: 990, y: 10 }, 500, -500, screen)).toEqual({
      x: 1000,
      y: 0,
    });
    // Without a known screen size or a starting point there is nothing to draw.
    expect(moveCursorBy(null, 10, 10, screen)).toBeNull();
    expect(moveCursorBy({ x: 1, y: 1 }, 10, 10, null)).toBeNull();
    expect(moveCursorBy({ x: 1, y: 1 }, Number.NaN, 10, screen)).toBeNull();
  });

  it("draws the marker inside the letterboxed crop, not the stage", () => {
    // A 2:1 image in a square stage: 100 px of empty space top and bottom.
    const rect = { left: 10, top: 20, width: 400, height: 400 };
    const natural = { width: 800, height: 400 };
    const full = cursorMarkerPosition(
      { x: 500, y: 500 },
      rect,
      natural,
      { x: 0, y: 0, w: 1000, h: 1000 },
    );
    expect(full).toEqual({ x: 200, y: 200 });
    // Zoomed crops only contain their own region: the middle of the crop is
    // the middle of the drawn image, not the middle of the stage.
    expect(
      cursorMarkerPosition({ x: 750, y: 750 }, rect, natural, {
        x: 500,
        y: 500,
        w: 500,
        h: 500,
      }),
    ).toEqual({ x: 200, y: 200 });
    // A point outside the visible crop is not drawn at all.
    expect(
      cursorMarkerPosition({ x: 100, y: 100 }, rect, natural, {
        x: 500,
        y: 500,
        w: 500,
        h: 500,
      }),
    ).toBeNull();
    expect(cursorMarkerPosition(null, rect, natural)).toBeNull();
  });
});

describe("pointer seed", () => {
  const screen = { width: 1920, height: 1080 };

  it("turns the PC's absolute pointer pixels into screen units", () => {
    expect(pixelToUnit({ x: 960, y: 540 }, screen)).toEqual({ x: 500, y: 500 });
    expect(pixelToUnit({ x: 0, y: 0 }, screen)).toEqual({ x: 0, y: 0 });
    expect(pixelToUnit({ x: 5000, y: -20 }, screen)).toEqual({ x: 1000, y: 0 });
    // No screen size, no honest answer.
    expect(pixelToUnit({ x: 10, y: 10 }, null)).toBeNull();
    expect(pixelToUnit({ x: Number.NaN, y: 10 }, screen)).toBeNull();
  });
});
