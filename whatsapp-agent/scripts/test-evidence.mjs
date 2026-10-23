// Stable TAP summary across Node 20/22/24; never turn a missing summary into a pass.
export function testSummary(output, exitCode) {
  const metrics = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
    const match = String(output).match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    return [key, match ? Number(match[1]) : null];
  }));
  const duration = String(output).match(/^# duration_ms ([\d.]+)\r?$/m);
  return { ...metrics, durationMs: duration ? Number(duration[1]) : null, exitCode,
    passed: exitCode === 0 && metrics.tests > 0 && metrics.pass !== null && metrics.fail === 0 && metrics.cancelled === 0 };
}
