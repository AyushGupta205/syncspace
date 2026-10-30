import { useEffect, useRef } from 'react';

export function YouTubePlayer({
  state,
  canControl,
  authoritativeStateRef,
  stateAnchorRef,
  playerRef,
  reconcileRef,
  onTitleChange,
  onDurationChange,
  onPlayerStateChange,
  onNativePlaybackChange,
  onLoadingChange,
  onError,
}) {
  const mount = useRef(null);
  const player = useRef(null);
  const ready = useRef(false);
  const activeVideoId = useRef('');
  const pendingVideo = useRef(null);
  const pendingVideoTimeout = useRef(null);
  const canControlRef = useRef(canControl);
  const nativePlaybackChangeRef = useRef(onNativePlaybackChange);
  const programmaticCommands = useRef([]);
  const lastProgrammaticCommand = useRef(null);
  const nativeAction = useRef(null);
  canControlRef.current = canControl;
  nativePlaybackChangeRef.current = onNativePlaybackChange;

  const setIframeInteraction = (iframe) => {
    if (!iframe) return;
    iframe.style.pointerEvents = canControlRef.current ? 'auto' : 'none';
    iframe.tabIndex = canControlRef.current ? 0 : -1;
    if (!canControlRef.current && document.activeElement === iframe) iframe.blur();
  };

  const recordProgrammaticCommand = (next, playerState) => {
    programmaticCommands.current.push({
      videoId: next.videoId,
      revision: next.revision,
      playerState,
    });
  };

  const clearPendingVideo = () => {
    clearTimeout(pendingVideoTimeout.current);
    pendingVideoTimeout.current = null;
    pendingVideo.current = null;
  };

  const beginPendingVideo = (next, instance, command) => {
    clearPendingVideo();
    const pending = {
      videoId: next.videoId,
      revision: next.revision,
      isPlaying: next.isPlaying,
    };
    pendingVideo.current = pending;
    onLoadingChange?.(true);
    pendingVideoTimeout.current = setTimeout(() => {
      if (pendingVideo.current !== pending) return;
      onLoadingChange?.(false);
      if (pending.isPlaying) {
        onError?.('Your browser may have blocked autoplay. Use the YouTube player controls to start playback.');
      } else {
        onError?.('YouTube is taking too long to load this video. Please try again.');
      }
    }, 10000);

    if (command === 'load') {
      const elapsed = next.isPlaying
        ? Math.max(0, Date.now() - stateAnchorRef.current.receivedAt) / 1000
        : 0;
      instance.loadVideoById({
        videoId: next.videoId,
        startSeconds: next.currentTime + elapsed,
      });
    } else if (command === 'cue') {
      instance.cueVideoById({
        videoId: next.videoId,
        startSeconds: next.currentTime,
      });
    } else if (next.isPlaying) instance.playVideo();
    else instance.pauseVideo();
  };

  const apply = (next) => {
    const instance = player.current;
    if (!ready.current || !instance) return;
    if (nativeAction.current && next.revision > nativeAction.current.revision) {
      nativeAction.current = null;
    }

    if (activeVideoId.current !== next.videoId) {
      activeVideoId.current = next.videoId;
      beginPendingVideo(next, instance, next.isPlaying ? 'load' : 'cue');
      return;
    }

    if (pendingVideo.current?.videoId === next.videoId) {
      const pending = pendingVideo.current;
      if (
        pending.revision !== next.revision &&
        pending.isPlaying !== next.isPlaying
      ) {
        beginPendingVideo(next, instance, 'playback');
      }
      return;
    }

    const elapsed = next.isPlaying
      ? Math.max(0, Date.now() - stateAnchorRef.current.receivedAt) / 1000
      : 0;
    const expectedTime = next.currentTime + elapsed;
    const currentTime = instance.getCurrentTime?.() || 0;
    const playerState = instance.getPlayerState?.();
    if (playerState === -1 || playerState === 3) return;
    const matchesAuthoritativePlayback = next.isPlaying
      ? playerState === 1
      : playerState === 2 || playerState === 5;
    if (matchesAuthoritativePlayback) {
      programmaticCommands.current = [];
    }
    if (Math.abs(currentTime - expectedTime) > 1.5) {
      instance.seekTo(expectedTime, true);
    }

    if (next.isPlaying && playerState !== 1) {
      const command = `${next.videoId}:${next.revision}:1`;
      if (lastProgrammaticCommand.current === command) return;
      lastProgrammaticCommand.current = command;
      recordProgrammaticCommand(next, 1);
      instance.playVideo();
    } else if (!next.isPlaying && playerState !== 2 && playerState !== 5) {
      const command = `${next.videoId}:${next.revision}:2`;
      if (lastProgrammaticCommand.current === command) return;
      lastProgrammaticCommand.current = command;
      recordProgrammaticCommand(next, 2);
      instance.pauseVideo();
    }
  };

  useEffect(() => {
    const fetchMeta = (instance) => {
      try {
        const title = instance?.getVideoData?.()?.title;
        if (title) onTitleChange(title);
        const dur = instance?.getDuration?.();
        if (dur) onDurationChange?.(dur);
      } catch {
        // Player metadata is optional and may be unavailable before the video loads.
      }
    };

    const create = () => {
      if (!mount.current || player.current || !window.YT?.Player) return;
      player.current = new window.YT.Player(mount.current, {
        videoId: authoritativeStateRef.current.videoId,
        playerVars: {
          controls: 1,
          disablekb: 0,
          fs: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            ready.current = true;
            onError?.('');
            if (playerRef) playerRef.current = event.target;
            const iframe = event.target?.getIframe?.();
            if (iframe) {
              iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen');
              iframe.setAttribute('allowfullscreen', 'true');
              setIframeInteraction(iframe);
            }
            fetchMeta(event.target);
            reconcileRef.current = apply;
            if (authoritativeStateRef.current.videoId) {
              apply(authoritativeStateRef.current);
            } else {
              onLoadingChange?.(false);
            }
          },
          onStateChange: (event) => {
            const instance = event.target;
            const reportedVideoId = instance?.getVideoData?.()?.video_id;
            if (
              reportedVideoId &&
              activeVideoId.current &&
              reportedVideoId !== activeVideoId.current
            ) {
              return;
            }
            const playerState = instance?.getPlayerState?.();
            if (
              [1, 2, 5].includes(event?.data) &&
              playerState !== event.data
            ) {
              apply(authoritativeStateRef.current);
              return;
            }
            const pending = pendingVideo.current;
            if (pending) {
              const eventVideoId = reportedVideoId || activeVideoId.current;
              if (eventVideoId !== pending.videoId) return;
              if (
                (event?.data === 1 && pending.isPlaying) ||
                ((event?.data === 2 || event?.data === 5) && !pending.isPlaying)
              ) {
                clearPendingVideo();
                fetchMeta(instance);
                onLoadingChange?.(false);
                onPlayerStateChange?.(event.data === 1);
                apply(authoritativeStateRef.current);
                return;
              } else if (event?.data === 2 && pending.isPlaying) {
                onLoadingChange?.(false);
                onError?.('Your browser may have blocked autoplay. Use the YouTube player controls to start playback.');
                return;
              } else {
                if (event?.data === -1 || event?.data === 3) {
                  onLoadingChange?.(true);
                }
                return;
              }
            }
            fetchMeta(instance);

            if (event?.data === 1) {
              onLoadingChange?.(false);
              onError?.('');
            } else if (event?.data === 2) {
              onLoadingChange?.(false);
            } else if (event?.data === -1 || event?.data === 3) {
              onLoadingChange?.(true);
            } else if (event?.data === 5) {
              onLoadingChange?.(false);
            }

            if (event?.data === 1 || event?.data === 2) {
              const next = authoritativeStateRef.current;
              const commandIndex = programmaticCommands.current.findIndex(
                (command) =>
                  command.videoId === (reportedVideoId || activeVideoId.current) &&
                  command.playerState === event.data
              );
              if (commandIndex !== -1) {
                programmaticCommands.current.splice(commandIndex, 1);
                onPlayerStateChange?.(event.data === 1);
                apply(next);
                return;
              }

              const isPlaying = event.data === 1;
              const currentIntent =
                nativeAction.current?.revision === next.revision
                  ? nativeAction.current.isPlaying
                  : next.isPlaying;
              if (isPlaying !== currentIntent && canControlRef.current) {
                nativeAction.current = {
                  revision: next.revision,
                  isPlaying,
                };
                onPlayerStateChange?.(isPlaying);
                nativePlaybackChangeRef.current?.(
                  isPlaying,
                  instance.getCurrentTime?.() ?? next.currentTime
                );
                return;
              }

              onPlayerStateChange?.(isPlaying);
              apply(next);
            } else if (event?.data === 5) {
              apply(authoritativeStateRef.current);
            }
          },
          onError: (event) => {
            const failedVideoId = event?.target?.getVideoData?.()?.video_id;
            if (
              failedVideoId &&
              activeVideoId.current &&
              failedVideoId !== activeVideoId.current
            ) {
              return;
            }
            clearPendingVideo();
            onLoadingChange?.(false);
            let errorText = 'YouTube encountered an error loading this video.';
            if (event?.data === 150 || event?.data === 101) {
              errorText = 'The video owner has disabled playback in embedded players. Please choose another public video.';
            } else if (event?.data === 100) {
              errorText = 'This video does not exist or has been removed.';
            } else if (event?.data === 2) {
              errorText = 'Invalid YouTube video ID or parameter.';
            } else if (event?.data === 5) {
              errorText = 'HTML5 player error. Please try another video or refresh.';
            }
            onError?.(errorText);
          },
        },
      });
      if (playerRef) playerRef.current = player.current;
    };

    const old = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      old?.();
      create();
    };

    if (window.YT?.Player) {
      create();
    } else if (!document.querySelector('script[data-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.dataset.youtubeApi = 'true';
      script.onerror = () => {
        onLoadingChange?.(false);
        onError?.('Unable to load the YouTube player. Check your connection and try again.');
      };
      document.head.appendChild(script);
    }

    return () => {
      window.onYouTubeIframeAPIReady = old;
      clearPendingVideo();
      if (reconcileRef.current === apply) reconcileRef.current = null;
      ready.current = false;
      player.current?.destroy();
      player.current = null;
      if (playerRef) playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    setIframeInteraction(player.current?.getIframe?.());
    apply(authoritativeStateRef.current);
  }, [canControl]);

  useEffect(() => {
    apply(authoritativeStateRef.current);
  }, [state.videoId, state.currentTime, state.isPlaying, state.revision]);

  useEffect(() => {
    const timer = setInterval(() => apply(authoritativeStateRef.current), 2000);
    return () => clearInterval(timer);
  }, []);

  return <div className="youtube-player" ref={mount} />;
}
