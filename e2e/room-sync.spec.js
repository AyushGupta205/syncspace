import { test, expect } from '@playwright/test';

const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const VIDEO_C = 'M7lc1UVf-VE';

const changeVideo = async (page, videoId) => {
  await page.getByRole('button', { name: 'Toggle change video input' }).click();
  await page.getByPlaceholder(/Paste YouTube link/).fill(videoId);
  await page.getByRole('button', { name: 'Load Video' }).click();
};

const stubPlayer = (readyDelay = 250) => {
  window.YT = {
    Player: class {
      constructor(element, options) {
        this.state = -1;
        this.time = 0;
        this.videoId = options.videoId;
        this.options = options;
        this.loadCalls = [];
        this.cueCalls = [];
        this.commandLog = [];
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.stateEvents = [];
        this.playDelay = 0;
        this.pauseDelay = 0;
        this.pauseOnNextPlay = false;
        window.__youtubePlayerCount = (window.__youtubePlayerCount || 0) + 1;
        window.__youtubePlayers = window.__youtubePlayers || [];
        window.__youtubePlayers.push(this);
        window.__youtubePlayerVars = options.playerVars;
        this.iframe = document.createElement('iframe');
        this.iframe.title = 'Mock YouTube player';
        this.iframe.dataset.videoId = options.videoId;
        element.replaceChildren(this.iframe);
        setTimeout(() => options.events.onReady({ target: this }), readyDelay);
      }

      getCurrentTime() { return this.time; }
      getDuration() { return 600; }
      getPlayerState() { return this.state; }
      getVideoData() { return { title: 'Mock video', video_id: this.videoId }; }
      getIframe() { return this.iframe; }
      emitState(data, videoId = this.videoId, source = 'event') {
        this.stateEvents.push({ data, state: this.state, videoId, source, time: this.time });
        const target = Object.create(this);
        target.getVideoData = () => ({ title: 'Mock video', video_id: videoId });
        this.options.events.onStateChange({ target, data });
      }
      loadVideoById({ videoId, startSeconds = 0 }) {
        this.commandLog.push({ command: 'load', videoId });
        this.loadCalls.push(videoId);
        this.videoId = videoId;
        this.iframe.dataset.videoId = videoId;
        this.time = startSeconds;
        this.state = 3;
        this.emitState(3);
        setTimeout(() => {
          if (this.videoId !== videoId) {
            this.emitState(1, videoId);
            return;
          }
          this.state = 1;
          this.emitState(1, this.videoId, 'programmatic-load');
        }, 60);
      }
      cueVideoById({ videoId, startSeconds = 0 }) {
        this.commandLog.push({ command: 'cue', videoId });
        this.cueCalls.push(videoId);
        this.videoId = videoId;
        this.iframe.dataset.videoId = videoId;
        this.time = startSeconds;
        this.state = 5;
        this.emitState(5, this.videoId, 'programmatic-cue');
      }
      seekTo(time) { this.time = time; }
      playVideo() {
        this.playCalls += 1;
        this.commandLog.push({ command: 'play', videoId: this.videoId });
        const delay = this.playDelay;
        this.playDelay = 0;
        if (this.pauseOnNextPlay) {
          this.pauseOnNextPlay = false;
          this.state = 1;
          this.emitState(2, this.videoId, 'play-mismatch');
        }
        const completePlay = () => {
          this.state = 1;
          this.emitState(1, this.videoId, 'programmatic-play');
        };
        if (delay) setTimeout(completePlay, delay);
        else completePlay();
      }
      pauseVideo() {
        this.pauseCalls += 1;
        this.commandLog.push({ command: 'pause', videoId: this.videoId });
        const delay = this.pauseDelay;
        this.pauseDelay = 0;
        const completePause = () => {
          this.state = 2;
          this.emitState(2, this.videoId, 'programmatic-pause');
        };
        if (delay) setTimeout(completePause, delay);
        else completePause();
      }
      nativePlay() {
        this.commandLog.push({ command: 'native-play', videoId: this.videoId });
        this.state = 1;
        this.emitState(1, this.videoId, 'native-play');
      }
      nativePause() {
        this.commandLog.push({ command: 'native-pause', videoId: this.videoId });
        this.state = 2;
        this.emitState(2, this.videoId, 'native-pause');
      }
      scheduleState(state, delay) {
        setTimeout(() => {
          this.state = state;
          this.emitState(state);
        }, delay);
      }
      scheduleCallback(state, delay) {
        setTimeout(() => this.emitState(state), delay);
      }
      destroy() { this.iframe.remove(); }
    },
  };
};

test('stale playback acknowledgements cannot alter the reconnected queue or revision', async ({ page, baseURL }) => {
  await page.addInitScript(stubPlayer);
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const { mountRoomHarness } = await import('/e2e/room-harness.jsx');
    window.__roomHarness = mountRoomHarness();
  });
  await expect(page.locator('#room-harness .youtube-player iframe')).toHaveCount(1);
  await expect(page.locator('#room-harness .player-loading-overlay')).toHaveCount(0);

  await page.getByRole('button', { name: 'Play synchronized playback' }).last().click();
  await expect.poll(() => page.evaluate(() => window.__roomHarness.playbackAcks.length)).toBe(1);
  await page.evaluate(() => {
    const harness = window.__roomHarness;
    harness.socket.setConnected(false);
    harness.socket.setConnected(true);
    harness.socket.dispatch('sync_state', {
      videoId: 'dQw4w9WgXcQ',
      currentTime: 0,
      isPlaying: false,
      revision: 11,
    });
    harness.acknowledge(0, { state: { revision: 99 } });
    window.__youtubePlayers.at(-1).nativePlay();
  });
  await expect.poll(() => page.evaluate(() => window.__roomHarness.playbackAcks.length)).toBe(2);
  expect(await page.evaluate(() => window.__roomHarness.playbackAcks[1].data.expectedRevision))
    .toBe(11);

  await page.evaluate(() => {
    const harness = window.__roomHarness;
    harness.socket.setConnected(false);
    harness.socket.setConnected(true);
    harness.socket.dispatch('sync_state', {
      videoId: 'dQw4w9WgXcQ',
      currentTime: 0,
      isPlaying: false,
      revision: 12,
    });
  });
  await page.getByRole('button', { name: 'Play synchronized playback' }).last().click();
  await page.getByRole('button', { name: 'Forward 10 seconds' }).last().click();
  await expect.poll(() => page.evaluate(() => window.__roomHarness.playbackAcks.length)).toBe(3);

  await page.evaluate(() => {
    window.__roomHarness.acknowledge(1, { error: 'stale connection failure' });
  });
  await expect(page.locator('#room-harness [role="alert"]')).toHaveCount(0);
  await page.evaluate(() => {
    window.__roomHarness.acknowledge(2, { state: { revision: 13 } });
  });
  await expect.poll(() => page.evaluate(() => window.__roomHarness.playbackAcks.length)).toBe(4);
  expect(await page.evaluate(() => window.__roomHarness.playbackAcks[3].data.type)).toBe('seek');

  await page.evaluate(() => window.__roomHarness.cleanup());
});

test('a disconnect cancels the 400ms connected-status transition', async ({ page, baseURL }) => {
  await page.addInitScript(stubPlayer);
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const { mountRoomHarness } = await import('/e2e/room-harness.jsx');
    window.__roomHarness = mountRoomHarness();
  });
  const status = page.locator('#room-harness .sync-status-label');
  await expect(page.locator('#room-harness .youtube-player iframe')).toHaveCount(1);

  await page.evaluate(() => window.__roomHarness.socket.dispatch('connect'));
  await expect(status).toHaveText('Connected', { timeout: 200 });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__roomHarness.socket.setConnected(false));
  await expect(status).toHaveText('Connection lost');
  await page.waitForTimeout(450);
  await expect(status).toHaveText('Connection lost');

  await page.evaluate(() => window.__roomHarness.socket.setConnected(true));
  await expect(status).toHaveText('Connected');
  await expect(status).toHaveText('In sync', { timeout: 1000 });
  await page.evaluate(() => window.__roomHarness.cleanup());
});

test('leave confirmation contains keyboard focus and restores the opener on Escape', async ({ page, baseURL }) => {
  await page.addInitScript(stubPlayer);
  await page.goto(baseURL);
  await page.getByLabel(/Display name/).fill('DialogHost');
  await page.getByLabel(/YouTube URL or Video ID/).fill(VIDEO_A);
  await page.getByRole('button', { name: 'Start a Watch Party' }).click();
  await expect(page.locator('.room-code-pill .code-string')).toBeVisible();

  const leaveButton = page.getByRole('button', { name: 'Leave watch party' });
  const stayButton = page.getByRole('button', { name: 'Stay in Room' });
  const confirmButton = page.getByRole('button', { name: 'Yes, Leave Room' });
  await leaveButton.click();
  await expect(page.getByRole('dialog', { name: 'Leave Watch Party?' })).toBeVisible();
  await expect(stayButton).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(stayButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(leaveButton).toBeFocused();
});

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
      .toBe('none');
    await expect(guestPage.getByRole('slider', { name: 'Seek synchronized playback' })).toHaveCount(0);
    await expect(guestPage.locator('.video-container')).toHaveCSS('aspect-ratio', '16 / 9');

    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(hostPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);

    await guestPage.evaluate(() => window.__youtubePlayers.at(-1).nativePause());
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).nativePause();
      window.__youtubePlayers.at(-1).nativePlay();
      window.__youtubePlayers.at(-1).nativePause();
    });
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');

    await hostPage.evaluate(() => window.__youtubePlayers.at(-1).nativePlay());
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await hostPage.getByRole('button', { name: 'Forward 10 seconds' }).click();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    expect(await hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(11);
    expect(await guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(11);
    const hostSeekSlider = hostPage.getByRole('slider', { name: 'Seek synchronized playback' });
    await expect(hostSeekSlider).toBeEnabled();
    const seekSliderBounds = await hostSeekSlider.boundingBox();
    await hostPage.mouse.move(
      seekSliderBounds.x + 4,
      seekSliderBounds.y + seekSliderBounds.height / 2
    );
    await hostPage.mouse.down();
    await hostPage.mouse.move(
      seekSliderBounds.x + seekSliderBounds.width - 4,
      seekSliderBounds.y + seekSliderBounds.height / 2,
      { steps: 6 }
    );
    await hostPage.mouse.up();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).time))
      .toBeGreaterThan(590);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).time))
      .toBeGreaterThan(590);
    expect(await hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(610);
    expect(await guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeLessThan(610);
    await changeVideo(hostPage, VIDEO_C);
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_C);
    await expect(guestPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_C);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);

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
    await expect(guestPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(5);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(5);

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

    await guestPage.evaluate(() => window.__youtubePlayers.at(-1).nativePlay());
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await guestPage.evaluate(() => window.__youtubePlayers.at(-1).nativePause());
    const hostStatus = await hostPage.locator('.playback-status-pill strong').textContent();
    const hostPlayerState = await hostPage.evaluate(() => {
      const player = window.__youtubePlayers.at(-1);
      return {
        state: player.state,
        videoId: player.videoId,
        playCalls: player.playCalls,
        pauseCalls: player.pauseCalls,
        commandLog: player.commandLog,
        stateEvents: player.stateEvents,
      };
    });
    expect(hostStatus, JSON.stringify(hostPlayerState)).toBe('PAUSED');
    const moderatorSeekSlider = guestPage.getByRole('slider', { name: 'Seek synchronized playback' });
    await expect(moderatorSeekSlider).toBeEnabled();
    await moderatorSeekSlider.focus();
    await guestPage.keyboard.press('End');
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).time))
      .toBe(600);

    await guestPage.reload();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' })).toHaveCount(1);
    await expect(guestPage.locator('.youtube-player iframe'))
      .toHaveCSS('pointer-events', 'auto');
    expect(await guestPage.evaluate(() => window.__youtubePlayerCount)).toBe(guestPlayerCount);

    const recoveredHostStatus = await hostPage.locator('.playback-status-pill strong').textContent();
    const recoveredHostPlayer = await hostPage.evaluate(() => {
      const player = window.__youtubePlayers.at(-1);
      return {
        state: player.state,
        videoId: player.videoId,
        playCalls: player.playCalls,
        pauseCalls: player.pauseCalls,
        commandLog: player.commandLog,
        stateEvents: player.stateEvents,
      };
    });
    expect(recoveredHostStatus, JSON.stringify(recoveredHostPlayer)).toBe('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await changeVideo(guestPage, VIDEO_C);
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_C);
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    expect(await hostPage.evaluate(() => window.__youtubePlayerCount)).toBe(hostPlayerCount);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(5);

    await hostPage.locator('.person-row')
      .filter({ hasText: 'GuestUser' })
      .getByRole('button', { name: 'Make Host' })
      .click();
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Host');
    await expect(guestPage.locator('.person-row').filter({ hasText: 'HostUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).pauseOnNextPlay = true;
    });
    const hostCallsBeforePlay = await hostPage.evaluate(() => ({
      play: window.__youtubePlayers.at(-1).playCalls,
      pause: window.__youtubePlayers.at(-1).pauseCalls,
    }));
    const guestCallsBeforePlay = await guestPage.evaluate(() => ({
      play: window.__youtubePlayers.at(-1).playCalls,
      pause: window.__youtubePlayers.at(-1).pauseCalls,
    }));
    await guestPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(guestPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).playCalls))
      .toBe(hostCallsBeforePlay.play + 1);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).pauseCalls))
      .toBe(hostCallsBeforePlay.pause);
    await hostPage.reload();
    await expect(hostPage.locator('.person-row').filter({ hasText: 'HostUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    expect(await guestPage.evaluate((before) => ({
      play: window.__youtubePlayers.at(-1).playCalls - before.play,
      pause: window.__youtubePlayers.at(-1).pauseCalls - before.pause,
    }), guestCallsBeforePlay)).toEqual({ play: 1, pause: 0 });

    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).scheduleCallback(2, 3500);
    });
    await hostPage.waitForTimeout(3600);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect(guestPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();

    await hostPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);

    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).scheduleCallback(1, 500);
    });
    await guestPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(guestPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await guestPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await hostPage.waitForTimeout(600);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(2);

    await guestPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await changeVideo(guestPage, VIDEO_A);
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_A);
    await expect(guestPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_A);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);

    await guestPage.getByRole('button', { name: 'Forward 10 seconds' }).click();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).time)).toBeGreaterThanOrEqual(10);
    await guestPage.locator('.person-row')
      .filter({ hasText: 'HostUser' })
      .getByRole('button', { name: 'Make Host' })
      .click();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'HostUser' }).locator('.role-badge'))
      .toHaveText('Host');
    await expect(hostPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Moderator');
    await hostPage.reload();
    await expect(hostPage.locator('.person-row').filter({ hasText: 'HostUser' }).locator('.role-badge'))
      .toHaveText('Participant');
    await expect(guestPage.locator('.person-row').filter({ hasText: 'GuestUser' }).locator('.role-badge'))
      .toHaveText('Host');
    await guestPage.evaluate(() => window.__youtubePlayers.at(-1).nativePlay());
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await guestPage.evaluate(() => window.__youtubePlayers.at(-1).nativePause());
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(hostPage.getByText('In sync')).toBeVisible();
    expect(await hostPage.evaluate(() => window.__youtubePlayerCount)).toBe(hostPlayerCount);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('delayed programmatic callbacks cannot override newer shared playback', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await hostPage.addInitScript(stubPlayer);
    await guestPage.addInitScript(stubPlayer);
    await hostPage.goto(baseURL);
    await hostPage.getByLabel(/Display name/).fill('DelayedHost');
    await hostPage.getByLabel(/YouTube URL or Video ID/).fill(VIDEO_A);
    await hostPage.getByRole('button', { name: 'Start a Watch Party' }).click();
    await expect(hostPage.locator('.player-loading-overlay')).toHaveCount(0);
    const roomCode = await hostPage.locator('.room-code-pill .code-string').textContent();

    await guestPage.goto(`${baseURL}/?room=${roomCode}`);
    await guestPage.getByLabel(/Display name/).fill('DelayedGuest');
    await guestPage.getByRole('button', { name: 'Join Room' }).click();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'DelayedGuest' })).toBeVisible();
    await expect(guestPage.locator('.player-loading-overlay')).toHaveCount(0);

    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(hostPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');

    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).pauseDelay = 1000;
    });
    await hostPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');

    const stateEventCount = await hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).stateEvents.length
    );
    await expect.poll(() => hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).stateEvents.length
    )).toBeGreaterThan(stateEventCount);
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');

    await hostPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await hostPage.evaluate(() => {
      window.__youtubePlayers.at(-1).playDelay = 2000;
    });
    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PLAYING');
    await changeVideo(hostPage, VIDEO_B);
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);
    await expect(guestPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);
    await expect.poll(() => hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).state
    )).toBe(1);
    await hostPage.getByRole('button', { name: 'Pause synchronized playback' }).click();
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');

    const playEventCount = await hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).stateEvents.length
    );
    await expect.poll(() => hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).stateEvents.length
    )).toBeGreaterThan(playEventCount);
    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect.poll(() => hostPage.evaluate(
      () => window.__youtubePlayers.at(-1).state
    )).toBe(2);
    await expect.poll(() => guestPage.evaluate(
      () => window.__youtubePlayers.at(-1).state
    )).toBe(2);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('autoplay restrictions are reported without changing authoritative room state', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await hostPage.addInitScript(stubPlayer);
    await guestPage.addInitScript(stubPlayer);
    await hostPage.goto(baseURL);
    await hostPage.getByLabel(/Display name/).fill('AutoplayHost');
    await hostPage.getByLabel(/YouTube URL or Video ID/).fill(VIDEO_A);
    await hostPage.getByRole('button', { name: 'Start a Watch Party' }).click();
    await expect(hostPage.locator('.player-loading-overlay')).toHaveCount(0);
    const roomCode = await hostPage.locator('.room-code-pill .code-string').textContent();

    await guestPage.goto(`${baseURL}/?room=${roomCode}`);
    await guestPage.getByLabel(/Display name/).fill('AutoplayGuest');
    await guestPage.getByRole('button', { name: 'Join Room' }).click();
    await expect(guestPage.locator('.player-loading-overlay')).toHaveCount(0);

    await expect(hostPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    const playCalls = await hostPage.evaluate(() => window.__youtubePlayers.at(-1).playCalls);
    await hostPage.evaluate(() => {
      const player = window.__youtubePlayers.at(-1);
      player.state = 2;
      player.options.events.onAutoplayBlocked({ target: player });
    });

    await expect(hostPage.getByRole('alert')).toContainText('Your browser blocked autoplay');
    await expect(guestPage.locator('.playback-status-pill strong')).toHaveText('PAUSED');
    expect(await hostPage.evaluate(() => window.__youtubePlayers.at(-1).playCalls)).toBe(playCalls);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('delayed YouTube readiness uses the latest room video and playback revision', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await hostPage.addInitScript(stubPlayer, 3000);
    await guestPage.addInitScript(stubPlayer, 4000);
    await hostPage.goto(baseURL);
    await hostPage.getByLabel(/Display name/).fill('DelayedHost');
    await hostPage.getByLabel(/YouTube URL or Video ID/).fill(VIDEO_A);
    await hostPage.getByRole('button', { name: 'Start a Watch Party' }).click();
    await expect(hostPage.locator('.room-code-pill .code-string')).toBeVisible();
    await expect(hostPage.locator('.player-loading-overlay')).toBeVisible();

    await changeVideo(hostPage, VIDEO_B);
    await expect(hostPage.locator('.player-loading-overlay')).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).videoId))
      .toBe(VIDEO_B);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).cueCalls))
      .toEqual([VIDEO_B]);
    const roomCode = await hostPage.locator('.room-code-pill .code-string').textContent();
    await expect(hostPage.locator('.player-loading-overlay')).toHaveCount(0, { timeout: 5000 });
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(5);

    await guestPage.goto(`${baseURL}/?room=${roomCode}`);
    await guestPage.getByLabel(/Display name/).fill('DelayedGuest');
    await guestPage.getByRole('button', { name: 'Join Room' }).click();
    await expect(guestPage.locator('.person-row').filter({ hasText: 'DelayedGuest' })).toBeVisible();
    await expect(guestPage.locator('.player-loading-overlay')).toBeVisible();

    await hostPage.getByRole('button', { name: 'Play synchronized playback' }).click();
    await changeVideo(hostPage, VIDEO_C);
    await changeVideo(hostPage, VIDEO_A);
    await changeVideo(hostPage, VIDEO_B);
    await expect(hostPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);
    await expect(guestPage.locator('.youtube-player iframe')).toHaveAttribute('data-video-id', VIDEO_B);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).videoId))
      .toBe(VIDEO_B);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).loadCalls))
      .toEqual([VIDEO_B]);
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
    await expect.poll(() => hostPage.evaluate(() => window.__youtubePlayers.at(-1).loadCalls))
      .toEqual([VIDEO_C, VIDEO_A, VIDEO_B]);

    await hostPage.evaluate(
      (oldVideoId) => window.__youtubePlayers.at(-1).emitState(2, oldVideoId),
      VIDEO_C
    );
    await expect(hostPage.getByRole('button', { name: 'Pause synchronized playback' })).toBeVisible();
    await expect.poll(() => guestPage.evaluate(() => window.__youtubePlayers.at(-1).state)).toBe(1);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
