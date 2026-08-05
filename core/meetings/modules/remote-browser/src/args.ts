/**
 * args — Chromium launch flags for the persistent-context (authenticated /
 * interactive) browser. Carved verbatim from vexa-bot/constans.ts.
 *
 * NOTE the deliberate restraint: NO --disable-web-security / --ignore-certificate-errors
 * here. Those are detectable by Google's bot layer and trigger "You can't join this
 * video call" on datacenter egress. Persistent-context mode uses the minimal clean set
 * plus --disable-blink-features=AutomationControlled. This is NOT --incognito — incognito
 * wipes the stored cookies that make an authenticated join work.
 *
 * (The *meeting* args — getBrowserArgs / browserArgs / userAgent, built on the join
 * brick's JOIN_BROWSER_ARGS — stay in vexa-bot/constans.ts; those are a bot concern.)
 */

// CDP debug args — let an agent attach over the gateway /b/{token}/cdp proxy to clear
// captcha/blocking states. Chrome binds 9222 on 127.0.0.1; the entrypoint socat relay
// re-exposes it on 0.0.0.0:9223 for the gateway to reach across the docker network.
export const CDP_DEBUG_ARGS = [
  '--remote-debugging-port=9222',
  '--remote-debugging-address=0.0.0.0',
  '--remote-allow-origins=*',
];

/**
 * GPU launch flags for the host's BROWSER_HWACCEL mode. Default (none / unknown) = the measured
 * software setup (--disable-gpu + --in-process-gpu + VizDisplayCompositor off); a hardware mode turns
 * on Chromium's VA-API decoder so incoming video decodes on the GPU instead of the CPU.
 *
 * DUPLICATED (deliberately) from @vexa/join's getGpuBrowserArgs — this brick has no @vexa/join dep and
 * must stay self-contained (isolation law). The CONTRACT is the shared BROWSER_HWACCEL env var; keep the
 * two readers in sync. A meeting launch concatenates both bricks' args, so identical flags simply dedup.
 */
function getGpuArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.BROWSER_HWACCEL || '').trim().toLowerCase();
  const hardware = raw !== '' && raw !== 'none' && raw !== 'software' && raw !== 'off' && raw !== 'cpu';
  if (!hardware) return ['--disable-gpu', '--in-process-gpu', '--disable-features=VizDisplayCompositor'];
  return [
    '--ignore-gpu-blocklist',
    '--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL',
    '--use-gl=angle',
    '--use-angle=gl',
  ];
}

/**
 * Browser args for authenticated bot mode (persistent context with stored cookies).
 * Minimal, clean flags — aggressive flags like --disable-web-security and
 * --ignore-certificate-errors trigger Google's bot detection and cause "You can't
 * join this video call" blocks.
 */
export function getAuthenticatedBrowserArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=/dev/null',
    ...getGpuArgs(),
    '--password-store=basic',
  ];
}

/**
 * Browser args for interactive browser-session mode (VNC + CDP).
 * No incognito, no fake media — a human interacts via VNC, an agent via CDP.
 */
export function getBrowserSessionArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--use-fake-ui-for-media-stream',
    '--start-maximized',
    '--window-size=1920,1080',
    '--window-position=0,0',
    ...CDP_DEBUG_ARGS,
    '--password-store=basic',
  ];
}
