/**
 * Canonical browser launch args for joining a meeting — the SINGLE source of truth
 * for the browser environment the join layer requires.
 *
 * Who consumes this (so it never drifts):
 *  - the `vexa-bot` service builds its real meeting launches on top of these
 *    (services/vexa-bot/core/src/constans.ts → baseBrowserArgs), then layers on
 *    bot-only concerns (voice-agent audio, CDP debug exposure);
 *  - the standalone debug harness (scripts/debug-join.ts) launches with these
 *    verbatim, so the hot-debug container reproduces production exactly.
 *
 * The isolation law (modules never import services) makes this the only place the
 * set can live without drift: the service imports FROM here, never the reverse.
 *
 * Pack F (2026-06-06): deliberately NO --ignore-certificate-errors / --ignore-ssl-errors
 * / --disable-web-security / --allow-running-insecure-content — those are detectable by
 * Google's bot-detection layer and directly cause the "You can't join this meeting"
 * interstitial on datacenter egress IPs. Meet uses valid TLS; init-scripts inject via
 * CDP (unaffected by CSP). --disable-blink-features=AutomationControlled replaces them.
 *
 * #856 (2026-07-23): the browser UI locale is now PINNED. We never used to tell
 * the browser what language to be, so Google Meet localised from Accept-Language
 * or IP geolocation and served non-English lobbies on EU/other egress — the root
 * cause of the join-button-not-found class (#846). `--lang` / `--accept-lang`
 * pin Chrome's own UI + Accept-Language header; the Playwright context `locale`
 * (remote-browser/browser.ts) pins navigator.language. The pinned value is a
 * deployment knob — BOT_UI_LOCALE, default en-US — so a deployment that genuinely
 * wants another UI language can set it. This is what makes the English lobby
 * selectors correct BY CONSTRUCTION rather than lucky.
 */

/** The pinned browser UI locale (#856). Deployment knob; default en-US. */
export function resolveBotUiLocale(): string {
  const v = (process.env.BOT_UI_LOCALE || "").trim();
  return v.length > 0 ? v : "en-US";
}

/** `--lang` / `--accept-lang` flags for the pinned UI locale (#856). Kept out of
 *  the static array below because they resolve an env knob at call time. */
export function getLocaleBrowserArgs(): string[] {
  const locale = resolveBotUiLocale();
  const primaryLang = locale.split("-")[0];
  const acceptLang = primaryLang && primaryLang !== locale ? `${locale},${primaryLang}` : locale;
  return [`--lang=${locale}`, `--accept-lang=${acceptLang}`];
}

// Chromium window size — matches the Xvfb screen the bot entrypoint sized from
// VIDEO_RESOLUTION (VEXA_VIDEO_WIDTH/HEIGHT). Outside that container (tests, the debug
// harness, local dev) the vars are unset and it falls back to 1080p, today's behavior.
const VIDEO_W = process.env.VEXA_VIDEO_WIDTH || "1920";
const VIDEO_H = process.env.VEXA_VIDEO_HEIGHT || "1080";

/**
 * Browser GPU mode — a HOST knob (BROWSER_HWACCEL), default 'none' = the measured software setup.
 *
 * The VA-API DECODE modes (nvidia/amd/intel/vaapi) move Chromium's video DECODE onto the GPU. But the
 * dominant per-bot CPU cost turned out to be RASTERIZATION/COMPOSITING (SwiftShader drawing the meeting
 * for x11grab), not decode — so the `vulkan` mode below offloads THAT to the GPU (ANGLE-over-Vulkan on
 * the NVIDIA Vulkan ICD). Each hardware mode needs its driver in the image AND the GPU exposed with the
 * `graphics` capability — else Chromium SILENTLY falls back to SwiftShader (verify at chrome://gpu).
 *
 *   none (default) — software: --disable-gpu + --in-process-gpu (today's production behaviour, unchanged).
 *   nvidia         — VA-API → NVDEC decode via nvidia-vaapi-driver (needs LIBVA_DRIVER_NAME=nvidia).
 *   amd | intel    — VA-API → mesa (radeonsi / iHD); libva usually auto-detects from the DRI device.
 *   vaapi          — generic VA-API; let libva auto-detect the driver.
 *   vulkan         — GPU RASTERIZATION via ANGLE-over-Vulkan. Offloads the compositing that starves the
 *                    audio thread. Needs libvulkan1 + the NVIDIA Vulkan ICD in the image.
 *
 * Unknown values resolve to 'none' — a bad env value must never produce a broken launch.
 */
export type BrowserHwaccel = "none" | "nvidia" | "amd" | "intel" | "vaapi" | "vulkan";

const HWACCEL_ALIASES: Readonly<Record<string, BrowserHwaccel>> = {
  "": "none", none: "none", software: "none", off: "none", cpu: "none", swiftshader: "none",
  nvidia: "nvidia", nvenc: "nvidia", cuda: "nvidia", nvdec: "nvidia",
  amd: "amd", radeonsi: "amd", radeon: "amd",
  intel: "intel", ihd: "intel", i965: "intel",
  vaapi: "vaapi",
  vulkan: "vulkan", "angle-vulkan": "vulkan", gpu: "vulkan", raster: "vulkan",
};

/** Resolve BROWSER_HWACCEL to a mode (default/unknown → 'none'). */
export function resolveBrowserHwaccel(env: NodeJS.ProcessEnv = process.env): BrowserHwaccel {
  return HWACCEL_ALIASES[(env.BROWSER_HWACCEL || "").trim().toLowerCase()] ?? "none";
}

/**
 * GPU launch flags for the resolved mode. 'none' returns the EXACT software flags used today
 * (--disable-gpu + --in-process-gpu + VizDisplayCompositor off). Hardware modes drop --disable-gpu and
 * turn the GPU on — DECODE modes enable the VA-API decoder; `vulkan` enables GPU rasterization via ANGLE
 * over Vulkan (leaving the Viz compositor ON so the accelerated path is available). Per-Chromium-version
 * tuning may be needed — the mode is a lever; chrome://gpu is the proof.
 */
export function getGpuBrowserArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const mode = resolveBrowserHwaccel(env);
  if (mode === "none") {
    return ["--disable-gpu", "--in-process-gpu", "--disable-features=VizDisplayCompositor"];
  }
  if (mode === "vulkan") {
    // GPU RASTERIZATION on the NVIDIA Vulkan ICD — GPU ON (no --disable-gpu), Viz compositor ON.
    return [
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--enable-gpu-rasterization",
      "--use-gl=angle",
      "--use-angle=vulkan",
    ];
  }
  // VA-API DECODE modes (nvidia / amd / intel / vaapi)
  return [
    "--ignore-gpu-blocklist",
    "--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL",
    "--use-gl=angle",
    "--use-angle=gl",
  ];
}

/**
 * Apply the VA-API driver env for the resolved mode (call ONCE at bot startup — the launched browser
 * inherits process.env). nvidia's shim is not auto-selected, so force LIBVA_DRIVER_NAME=nvidia when the
 * host hasn't; amd/intel auto-detect from the DRI device, so they're left alone. No-op for software/vulkan.
 */
export function initBrowserHwaccelEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (resolveBrowserHwaccel(env) === "nvidia" && !env.LIBVA_DRIVER_NAME) env.LIBVA_DRIVER_NAME = "nvidia";
}

export const JOIN_BROWSER_ARGS: readonly string[] = [
  "--window-position=0,0",
  `--window-size=${VIDEO_W},${VIDEO_H}`,
  "--start-fullscreen",
  "--incognito",
  "--no-sandbox",
  // --test-type suppresses Chromium's "You are using an unsupported command-line flag: --no-sandbox"
  // yellow banner, which otherwise overlays the server-side video recording. --disable-infobars does
  // NOT hide this particular banner. (The old --disable-setuid-sandbox was redundant with --no-sandbox
  // — which already disables all sandboxing — and only added a second flag to that same banner, so it
  // was dropped.) --test-type is a mild automation signal; verified the Zoom/Meet join still admits.
  "--test-type",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-infobars",
  // GPU flags are NOT here — they depend on BROWSER_HWACCEL and are appended by getJoinBrowserArgs()
  // via getGpuBrowserArgs(). Default (none) is the measured software setup: --disable-gpu +
  // --in-process-gpu folds SwiftShader into the renderer (~115% vs ~357%/bot, 2026-04-27 Zoom Web).
  "--use-fake-ui-for-media-stream",
  // Start AudioContexts in 'running', not 'suspended' — the capture taps remote participant audio
  // via createMediaStreamSource; without this the worklet never fires and no PCM flows. (L4.)
  "--autoplay-policy=no-user-gesture-required",
  "--use-file-for-fake-video-capture=/dev/null",
  "--disable-blink-features=AutomationControlled",
  "--disable-site-isolation-trials",
];

/** The canonical join launch args, as a fresh mutable array per call. Includes
 *  the pinned-locale flags (#856) so every launch path — production bot and the
 *  debug harness — is byte-identical and speaks the same UI language. */
export function getJoinBrowserArgs(): string[] {
  return [...JOIN_BROWSER_ARGS, ...getGpuBrowserArgs(), ...getLocaleBrowserArgs()];
}
