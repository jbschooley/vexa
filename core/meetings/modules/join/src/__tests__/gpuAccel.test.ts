/**
 * gpuAccel.test — BROWSER_HWACCEL host knob: default software (unchanged), hardware modes flip Chromium
 * to the VA-API decoder, unknown values fall back to software, and nvidia forces the libva driver env.
 */
import assert from "assert";
import {
  resolveBrowserHwaccel, getGpuBrowserArgs, initBrowserHwaccelEnv, getJoinBrowserArgs,
} from "../browser-args";

const SOFTWARE = ["--disable-gpu", "--in-process-gpu", "--disable-features=VizDisplayCompositor"];
const has = (a: string[], f: string) => a.includes(f);
let pass = 0;
const ok = (c: boolean, m: string) => { assert(c, m); console.log(`  PASS  ${m}`); pass++; };

// ── default = software (unchanged production behaviour) ──
ok(resolveBrowserHwaccel({}) === "none", "unset BROWSER_HWACCEL → 'none'");
ok(resolveBrowserHwaccel({ BROWSER_HWACCEL: "banana" }) === "none", "unknown value → 'none' (never a broken launch)");
assert.deepStrictEqual(getGpuBrowserArgs({}), SOFTWARE, "software mode = the exact current flags");
ok(has(getJoinBrowserArgs(), "--disable-gpu"), "getJoinBrowserArgs() still carries --disable-gpu by default");

// ── hardware modes flip to VA-API decode, drop --disable-gpu ──
for (const mode of ["nvidia", "amd", "intel", "vaapi", "NVIDIA", "nvenc"]) {
  const args = getGpuBrowserArgs({ BROWSER_HWACCEL: mode });
  ok(!has(args, "--disable-gpu"), `${mode}: no --disable-gpu`);
  ok(has(args, "--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL"), `${mode}: VA-API decoder enabled`);
}

// ── nvidia forces LIBVA_DRIVER_NAME; others don't; a host override wins ──
const nv: NodeJS.ProcessEnv = { BROWSER_HWACCEL: "nvidia" };
initBrowserHwaccelEnv(nv);
ok(nv.LIBVA_DRIVER_NAME === "nvidia", "nvidia → LIBVA_DRIVER_NAME=nvidia set");
const amd: NodeJS.ProcessEnv = { BROWSER_HWACCEL: "amd" };
initBrowserHwaccelEnv(amd);
ok(amd.LIBVA_DRIVER_NAME === undefined, "amd → LIBVA_DRIVER_NAME left for libva auto-detect");
const nvOverride: NodeJS.ProcessEnv = { BROWSER_HWACCEL: "nvidia", LIBVA_DRIVER_NAME: "custom" };
initBrowserHwaccelEnv(nvOverride);
ok(nvOverride.LIBVA_DRIVER_NAME === "custom", "an explicit LIBVA_DRIVER_NAME is never overridden");
const soft: NodeJS.ProcessEnv = { BROWSER_HWACCEL: "none" };
initBrowserHwaccelEnv(soft);
ok(soft.LIBVA_DRIVER_NAME === undefined, "software mode sets no libva driver");

console.log(`\n=== summary: ${pass} passed, 0 failed ===`);
