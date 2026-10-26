import fs from "node:fs";

/**
 * Static guards for the layout contracts that only break on a real phone, where
 * the layout viewport and the visible viewport are two different sizes.
 *
 * A viewport-relative max-height sizes the panel against the layout viewport,
 * which does not shrink when the mobile URL bar collapses or the on-screen
 * keyboard opens, so the panel either clips its own content or leaves dead
 * space. Every one of them must ride the tracked --app-height instead.
 */
const TAP = 44;
const css = fs.readFileSync("src/styles.css", "utf8");

const bad = [];
const vh = css.match(/max-height:\s*[\d.]+vh/g);
if (vh?.length) bad.push(`raw vh max-heights: ${vh.join(", ")}`);

// The modal is sized off the tracked variable so it stays on screen while the
// on-screen keyboard is open. 100dvh ignores the keyboard entirely.
if (!css.includes("max-height: calc(var(--app-height) - 48px)"))
  bad.push(".modal must be sized from --app-height, not 100dvh");

// Tap targets. Only rules that describe a tappable control are checked; dense
// remote-control surfaces (the PC dock) and decorative chrome are exempt
// because their size is the design, not a defect.
const EXEMPT = /pc-|avatar|dot|ripple|cursor|drag|divider|count|mark|chip|spinner|scroll|::|key$/i;
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
for (const m of css.matchAll(ruleRe)) {
  const [, sel, decl] = m;
  if (EXEMPT.test(sel)) continue;
  const h = decl.match(/(?<!min-)(?<!max-)height:\s*(\d+)px/);
  const min = decl.match(/min-height:\s*(\d+)px/);
  const hit = h ?? min;
  if (!hit) continue;
  const value = Number(hit[1]);
  if (value > 0 && value < TAP && /button|link|select|textarea|input|tab\b|row\b/i.test(sel))
    bad.push(`${sel.trim()} is ${value}px, under the ${TAP}px tap contract`);
}

if (bad.length) {
  console.error(bad.map((b) => `  ${b}`).join("\n"));
  process.exit(1);
}
console.log(`Layout contracts hold: no vh max-heights, no sub-${TAP}px tap targets.`);
