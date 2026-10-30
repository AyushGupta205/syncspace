import { test, expect } from '@playwright/test';

const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const VIDEO_C = 'M7lc1UVf-VE';

test('landing room-mode tabs and mobile layout stay usable', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);

  await expect(page.getByRole('heading', { name: /Press play.*Stay in sync/ })).toBeVisible();
  await expect(page.getByText('Create a room, invite your people, and watch YouTube together—with synchronized playback, live chat, and reactions.'))
    .toBeVisible();
  const createTab = page.getByRole('tab', { name: 'Create room' });
  const joinTab = page.getByRole('tab', { name: 'Join room' });
  await expect(createTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Start a Watch Party' })).toBeVisible();
  await joinTab.click();
  await expect(joinTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Room code *')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join Room' })).toBeVisible();
  await createTab.click();
  await expect(page.getByLabel('YouTube URL or Video ID (optional)')).toBeVisible();

  const layout = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector('.feature-grid')).gridTemplateColumns.split(' ').length,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    headerRight: document.querySelector('.landing-header').getBoundingClientRect().right,
  }));
  expect(layout.columns).toBe(2);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.headerRight).toBeLessThanOrEqual(layout.viewportWidth);

  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg-app').trim());
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  const lightTheme = await page.evaluate(() => ({
    background: getComputedStyle(document.body).getPropertyValue('--bg-app').trim(),
    foreground: getComputedStyle(document.body).getPropertyValue('--text-main').trim(),
    accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
  }));
  expect(lightTheme.background).not.toBe(darkBackground);
  expect(lightTheme.foreground).not.toBe('');
  expect(lightTheme.accent).not.toBe('');
});

test('playback controls, role changes, and reconnection preserve the player instance', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const stubPlayer = () => {
    window.YT = {
      Player: class {
        constructor(element, options) {
          this.state = 2;
          this.time = 0;
          window.__youtubePlayerCount = (window.__youtubePlayerCount || 0) + 1;
          window.__youtubePlayers = window.__youtubePlayers || [];
          window.__youtubePlayers.push(this);
          window.__youtubePlayerVars = options.playerVars;
          this.iframe = document.createElement('iframe');
          this.iframe.title = 'Mock YouTube player';
          this.iframe.dataset.videoId = options.videoId;
          element.replaceChildren(this.iframe);
          setTimeout(() => options.events.onReady({ target: this }), 250);
        }

        getCurrentTime() { return this.time; }
        getDuration() { return 600; }
        getPlayerState() { return this.state; }
        getVideoData() { return { title: 'Mock video' }; }
        getIframe() { return this.iframe; }
        loadVideoById({ videoId, startSeconds = 0 }) {
          this.iframe.dataset.videoId = videoId;
          this.time = startSeconds;
          this.state = 1;
        }
        cueVideoById({ videoId, startSeconds = 0 }) {
          this.iframe.dataset.videoId = videoId;
          this.time = startSeconds;
          this.state = 5;
        }
        seekTo(time) { this.time = time; }
        playVideo() { this.state = 1; }
        pauseVideo() { this.state = 2; }
        destroy() { this.iframe.remove(); }
      },
    };
  };

  try {
    await hostPage.addInitScript(stubPlayer);
    await guestPage.addInitScript(stubPlayer);
    await hostPage.goto(baseURL);
    await hostPage.getByLabel(/Display name/).fill('HostUser');
    await hostPage.getByLabel(/YouTube URL or Video ID/).fill(VIDEO_A);
    await hostPage.getByRole('button', { name: 'Start a Watch Party' }).click();
    await expect(hostPage.locator('.room-code-pill .code-string')).toBeVisible();
    await expect(hostPage.locator('.player-loading-overlay')).toBeVisible();
    await expect(hostPage.locator('.youtube-player iframe')).toHaveCount(1);
    await expect(hostPage.locator('.player-loading-overlay')).toHaveCount(0);
    const hostPlayerCount = await hostPage.evaluate(() => window.__youtubePlayerCount);
    const roomCode = await hostPage.locator('.room-code-pill .code-string').textContent();

    await guestPage.goto(`${baseURL}/?room=${roomCode}`);
    await guestPage.getByLabel(/Display name/).fill('GuestUser');
    await guestPage.getByRole('button', { name: 'Join Room' }).click();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' })).toBeVisible();
    expect(await guestPage.evaluate(() => window.__youtubePlayerVars.controls)).toBe(1);
    expect(await guestPage.evaluate(() => window.__youtubePlayerVars.disablekb)).toBe(0);
    expect(await guestPage.locator('.youtube-player iframe').evaluate((iframe) => getComputedStyle(iframe).pointerEvents))
      .toBe('auto');
    await expect(guestPage.locator('.video-container')).toHaveCSS('aspect-ratio', '16 / 9');

    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(hostPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await hostPage.getByRole('button', { name: 'Forward 10 seconds' }).click();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    expect(await hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(11);
    expect(await guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(11);
    await hostPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await expect(hostPage.getByRole('button', { name: 'Play synchronized playback' })).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);

    await guestPage.getByRole('button', { name: 'Request a change' }).click();
    await guestPage.getByLabel('Change to request').selectOption('video');
    await guestPage.getByLabel('Requested YouTube video').fill(VIDEO_B);
    await guestPage.getByRole('button', { name: 'Send request' }).click();
    await expect(hostPage.getByRole('region', { name: 'Pending playback requests' }))
      .toContainText('GuestUser');
    await hostPage.getByRole('button', { name: 'Approve playback request from GuestUser' }).click();
    await expect(guestPage.locator('.request-status')).toContainText('Your request was approved.');
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);

    await guestPage.reload();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Participant');
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' })).toHaveCount(1);
    expect(await guestPage.evaluate(() => window.__youtubePlayerVars.controls)).toBe(1);
    const guestPlayerCount = await guestPage.evaluate(() => window.__youtubePlayerCount);
    expect(guestPlayerCount).toBeGreaterThan(0);

    await hostPage.locator('.person-row')
      .filter({ hasText: 'GuestUser' })
      .getByRole('button', { name: 'Make mod' })
      .click();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    expect(await guestPage.evaluate(() => window.__youtubePlayerCount)).toBe(guestPlayerCount);
    await expect(guestPage.locator('.youtube-player iframe'))
      .toHaveCSS('pointer-events', 'auto');
    await guestPage.reload();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' })).toHaveCount(1);
    await expect(guestPage.locator('.youtube-player iframe'))
      .toHaveCSS('pointer-events', 'auto');
    expect(await guestPage.evaluate(() => window.__youtubePlayerCount)).toBe(guestPlayerCount);

    await guestPage.getByRole('button', { name: 'Toggle change video input' }).click();
    await guestPage.getByPlaceholder(/Paste YouTube link/).fill(VIDEO_C);
    await guestPage.getByRole('button', { name: 'Load Video' }).click();
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_C);
    expect(await hostPage.evaluate(() => window.__youtubePlayerCount)).toBe(hostPlayerCount);

    await hostPage.locator('.person-row')
      .filter({ hasText: 'GuestUser' })
      .getByRole('button', { name: 'Make Host' })
      .click();
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Host');
    await hostPage.reload();
    await expect(hostPage.locator('.person-row').filter({ hasText: 'HostUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await expect(hostPage.getByText('In sync')).toBeVisible();
    expect(await hostPage.evaluate(() => window.__youtubePlayerCount)).toBe(hostPlayerCount);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
