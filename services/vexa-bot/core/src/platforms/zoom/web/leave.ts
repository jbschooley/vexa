import { Page } from 'playwright';
import { log } from '../../../utils';
import { LeaveReason } from '../../shared/meetingFlow';
import { zoomLeaveButtonSelector, zoomLeaveConfirmSelector } from './selectors';
import { stopZoomWebRecording } from './recording';

export async function leaveZoomWebMeeting(
  page: Page | null,
  botConfig?: any,
  reason?: LeaveReason
): Promise<boolean> {
  log(`[Zoom Web] Leaving meeting (reason: ${reason || 'unspecified'})`);

  // Stop recording first
  try {
    await stopZoomWebRecording();
  } catch (e: any) {
    log(`[Zoom Web] Error stopping recording during leave: ${e.message}`);
  }

  if (!page || page.isClosed()) {
    log('[Zoom Web] Page not available for leave — skipping UI leave');
    return true;
  }

  try {
    // Move mouse to bottom-center of viewport to reveal the auto-hiding footer toolbar
    try {
      const viewport = page.viewportSize();
      if (viewport) {
        await page.mouse.move(viewport.width / 2, viewport.height - 10);
        await page.waitForTimeout(800);
      }
    } catch { /* non-fatal */ }

    // Click Leave button
    const leaveBtn = page.locator(zoomLeaveButtonSelector).first();
    const visible = await leaveBtn.isVisible({ timeout: 3000 });
    if (visible) {
      await leaveBtn.click();
      log('[Zoom Web] Clicked Leave button');

      // Wait for confirmation dialog to render, then click "Leave Meeting".
      // IMPORTANT: locator.isVisible() returns IMMEDIATELY (point-in-time check).
      // We must use waitFor() to actually wait for the dialog to appear.
      let confirmed = false;
      try {
        const confirmBtn = page.locator(zoomLeaveConfirmSelector).first();
        await confirmBtn.waitFor({ state: 'visible', timeout: 4000 });
        await confirmBtn.click();
        log('[Zoom Web] Confirmed leave');
        confirmed = true;
        await page.waitForTimeout(1500);
      } catch {
        log('[Zoom Web] Leave confirm dialog not found — trying Enter key');
        try {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        } catch { /* ignore */ }
      }

      // Always navigate away to ensure WebRTC tears down cleanly.
      // Without this, closing the browser looks like a connection drop
      // and Zoom keeps the participant lingering.
      if (!confirmed) {
        log('[Zoom Web] Navigating away to force WebRTC disconnect');
        await page.goto('about:blank').catch(() => {});
        await page.waitForTimeout(1000);
      }
    } else {
      log('[Zoom Web] Leave button not visible after footer reveal — forcing page navigation');
      await page.goto('about:blank').catch(() => {});
      await page.waitForTimeout(1000);
    }
    return true;
  } catch (e: any) {
    log(`[Zoom Web] Error during leave: ${e.message}`);
    return false;
  }
}
