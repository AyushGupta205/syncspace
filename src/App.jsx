import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Production uses the same Node origin. Vite proxies these endpoints locally.
const API = import.meta.env.VITE_SOCKET_URL || window.location.origin;

const videoIdFrom = (value) => {
  let input = String(value || '').trim();
  if (!input) return '';
  if (/^[\w-]{11}$/.test(input)) return input;
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    input = 'https://' + input;
  }
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/')[1]?.match(/^[\w-]{11}$/)?.[0] || '';
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return '';
    const candidate = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
    return /^[\w-]{11}$/.test(candidate || '') ? candidate : '';
  } catch {
    return '';
  }
};

export function App() {
  const [socket, setSocket] = useState(null);
  const [room, setRoom] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('syncspace-theme') || 'dark');
  const [session, setSession] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('syncspace-session'));
    } catch {
      return null;
    }
  });

  const [form, setForm] = useState(() => ({
    username: '',
    roomId: new URLSearchParams(window.location.search).get('room') || '',
    video: '',
  }));
  const [error, setError] = useState('');

  // Synchronize theme to document body and html for seamless styles
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.className = `theme-${theme}`;
  }, [theme]);

  useEffect(() => {
    const s = io(API);
    setSocket(s);
    return () => s.close();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const restore = () => {
      if (!session?.roomId || !session?.sessionToken) return;
      socket.emit('resume_room', session, (data) => {
        if (data?.error) {
          sessionStorage.removeItem('syncspace-session');
          setSession(null);
          setRoom(null);
          setError(data.error);
        } else if (data) {
          setRoom(data);
        }
      });
    };
    socket.on('connect', restore);
    socket.on('action_rejected', ({ message }) => setError(message));
    socket.on('removed_from_room', () => {
      sessionStorage.removeItem('syncspace-session');
      setSession(null);
      setError('You were removed from this watch party.');
      setRoom(null);
    });
    return () => {
      socket.off('connect', restore);
      socket.off('action_rejected');
      socket.off('removed_from_room');
    };
  }, [socket, session]);

  const enterRoom = (data) => {
    setRoom(data);
    const next = { roomId: data.roomId, sessionToken: data.self.sessionToken };
    sessionStorage.setItem('syncspace-session', JSON.stringify(next));
    setSession(next);
  };

  const enter = (mode) => {
    setError('');
    if (!socket?.connected) {
      return setError('Connecting to the watch-party server. Please wait a moment and try again.');
    }
    const username = form.username.trim();
    if (!username) {
      return setError('Please enter a display name to continue.');
    }

    if (mode === 'create') {
      const rawVideo = form.video.trim();
      const videoId = rawVideo ? videoIdFrom(rawVideo) : '';
      if (rawVideo && !videoId) {
        return setError('Please enter a valid YouTube video link or 11-character video ID.');
      }
      socket.emit('create_room', { username, videoId }, (data) => {
        if (data?.error) setError(data.error);
        else if (data) enterRoom(data);
      });
    } else {
      const cleanRoom = form.roomId.trim().toUpperCase();
      if (!cleanRoom || cleanRoom.length !== 6) {
        return setError('Please enter a valid 6-character room code.');
      }
      socket.emit('join_room', { username, roomId: cleanRoom }, (data) => {
        if (data?.error) setError(data.error);
        else if (data) enterRoom(data);
      });
    }
  };

  const leave = () => {
    if (room?.roomId) {
      socket?.emit('leave_room', { roomId: room.roomId });
    }
    sessionStorage.removeItem('syncspace-session');
    setSession(null);
    setRoom(null);
    if (window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.pathname);
    }
  };

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('syncspace-theme', next);
      return next;
    });
  };

  return (
    <div className={`app theme-${theme}`}>
      {room ? (
        <Room
          socket={socket}
          initial={room}
          leave={leave}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      ) : (
        <Landing
          form={form}
          setForm={setForm}
          error={error}
          setError={setError}
          enter={enter}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      )}
    </div>
  );
}

function ThemeToggle({ theme, toggleTheme }) {
  const isDark = theme === 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      type="button"
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {isDark ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        )}
      </span>
      <span className="theme-toggle-label">{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}

function Landing({ form, setForm, error, setError, enter, theme, toggleTheme }) {
  const initialRoomParam = useMemo(
    () => new URLSearchParams(window.location.search).get('room') || '',
    []
  );

  const [mode, setMode] = useState(() => (initialRoomParam ? 'join' : 'create'));

  const update = (key) => (e) => {
    if (error) setError('');
    const val = key === 'roomId' ? e.target.value.toUpperCase().slice(0, 6) : e.target.value;
    setForm((prev) => ({ ...prev, [key]: val }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    enter(mode);
  };

  return (
    <main className="landing">
      {/* 7. Background: Ambient Lighting & Abstract Collaboration/Sync Visual */}
      <div className="landing-ambient-bg" aria-hidden="true">
        <div className="ambient-glow glow-1"></div>
        <div className="ambient-glow glow-2"></div>
        <div className="ambient-pattern"></div>
        <div className="ambient-sync-viewport">
          <div className="ambient-viewport-header">
            <span className="viewport-dot"></span>
            <span className="viewport-dot"></span>
            <span className="viewport-dot"></span>
            <span className="viewport-pill">LIVE SYNC • 1080P</span>
          </div>
          <div className="ambient-viewport-body">
            <svg viewBox="0 0 280 90" fill="none" className="ambient-viewport-svg" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 45 C 50 10, 100 80, 140 45 C 180 10, 230 80, 270 45" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.25" strokeDasharray="4 4"/>
              <path d="M10 45 C 60 75, 90 20, 140 45 C 190 70, 220 20, 270 45" stroke="var(--accent)" strokeWidth="1.5" strokeOpacity="0.5"/>
              <circle cx="140" cy="45" r="4.5" fill="var(--accent)"/>
              <circle cx="140" cy="45" r="12" stroke="var(--accent)" strokeWidth="1" strokeOpacity="0.35"/>
            </svg>
          </div>
        </div>
      </div>

      <header className="landing-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
              <polygon points="10,8 15,11 10,14" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1" />
            </svg>
          </div>
          <span className="brand-title">Syncspace</span>
        </div>

        <div className="header-meta">
          <div className="tagline-badge" title="Syncspace status">
            <span className="live-dot" aria-hidden="true"></span>
            <span className="tagline-copy">Live rooms, zero friction.</span>
          </div>
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
        </div>
      </header>

      <div className="landing-body">
        <section className="hero-section">
          <div className="hero-eyebrow">
            <span className="eyebrow-dash" aria-hidden="true"></span>
            <span>REAL-TIME YOUTUBE WATCH PARTY</span>
          </div>

          <h1 className="hero-headline">
            Everyone on<br />
            <em className="headline-accent">the same moment.</em>
          </h1>

          <p className="hero-description">
            Share one screen, synchronized playback, and instant reactions. Syncspace keeps your
            group in sync, wherever everyone is.
          </p>

          <div className="feature-grid" aria-label="Feature list">
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              </span>
              <span>Host &amp; Moderator controls</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              </span>
              <span>Real-time playback synchronization</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              </span>
              <span>One-click invite links</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              </span>
              <span>Built-in group chat</span>
            </div>
          </div>
        </section>

        <section className="card-section" aria-label="Room actions">
          <div className="launch-card">
            {initialRoomParam && mode === 'join' && (
              <div className="shared-invite-banner" role="status">
                <span className="invite-emoji">🎉</span>
                <div className="invite-text">
                  <strong>Room invite detected:</strong> Room <code>{initialRoomParam}</code>
                </div>
              </div>
            )}

            {mode === 'create' ? (
              /* 5. Room Creation Form */
              <form className="card-form" onSubmit={handleSubmit} noValidate>
                <div className="form-group">
                  <label htmlFor="display-name" className="input-label">
                    Display name <span className="required-mark">*</span>
                  </label>
                  <input
                    id="display-name"
                    type="text"
                    autoComplete="nickname"
                    maxLength={24}
                    placeholder="Enter your display name"
                    value={form.username}
                    onChange={update('username')}
                    className="text-input"
                    required
                  />
                  <p className="input-caption">
                    You will enter as the Host with moderation rights.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="video-url" className="input-label">
                    YouTube URL or Video ID <span className="optional-tag">(optional)</span>
                  </label>
                  <input
                    id="video-url"
                    type="text"
                    placeholder="Paste a YouTube URL or video ID"
                    value={form.video}
                    onChange={update('video')}
                    className="text-input"
                  />
                  <p className="input-caption">
                    Start with a video immediately, or leave it blank to choose one inside.
                  </p>
                </div>

                {error && (
                  <div className="error-banner" role="alert">
                    <span className="error-icon" aria-hidden="true">⚠️</span>
                    <span className="error-text">{error}</span>
                  </div>
                )}

                {/* 4. Action Buttons: Primary & Secondary */}
                <div className="card-actions-group">
                  <button className="primary-cta-btn" type="submit">
                    <span>Start a Watch Party</span>
                    <span className="btn-arrow" aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-cta-btn"
                    onClick={() => {
                      setMode('join');
                      if (error) setError('');
                    }}
                  >
                    <span>Join a Room</span>
                  </button>
                </div>
              </form>
            ) : (
              /* Room Joining Form */
              <form className="card-form" onSubmit={handleSubmit} noValidate>
                <div className="form-group">
                  <label htmlFor="display-name" className="input-label">
                    Display name <span className="required-mark">*</span>
                  </label>
                  <input
                    id="display-name"
                    type="text"
                    autoComplete="nickname"
                    maxLength={24}
                    placeholder="Enter your display name"
                    value={form.username}
                    onChange={update('username')}
                    className="text-input"
                    required
                  />
                  <p className="input-caption">
                    Shown in the participant roster and chat.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="room-code" className="input-label">
                    Room code <span className="required-mark">*</span>
                  </label>
                  <input
                    id="room-code"
                    type="text"
                    placeholder="6-CHARACTER CODE"
                    maxLength={6}
                    value={form.roomId}
                    onChange={update('roomId')}
                    className="text-input code-input"
                    autoCapitalize="characters"
                    required
                  />
                  <p className="input-caption">
                    Enter the 6-character code from your host or invitation link.
                  </p>
                </div>

                {error && (
                  <div className="error-banner" role="alert">
                    <span className="error-icon" aria-hidden="true">⚠️</span>
                    <span className="error-text">{error}</span>
                  </div>
                )}

                <div className="card-actions-group">
                  <button className="primary-cta-btn" type="submit">
                    <span>Join Room</span>
                    <span className="btn-arrow" aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-cta-btn"
                    onClick={() => {
                      setMode('create');
                      if (error) setError('');
                    }}
                  >
                    <span>Start a Watch Party</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      </div>

      <footer className="landing-footer">
        <div className="footer-wrapper">
          <p className="footer-line">Built for shared pauses, reactions, and plot twists.</p>
          <p className="footer-line footer-subline">Powered by YouTube &amp; Socket.IO</p>
        </div>
      </footer>
    </main>
  );
}

function Room({ socket, initial, leave, theme, toggleTheme }) {
  const [state, setState] = useState(initial.state);
  const [actualPlaying, setActualPlaying] = useState(initial.state.isPlaying);
  const [people, setPeople] = useState(initial.participants);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [chatError, setChatError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(initial.state.currentTime || 0);
  const [copied, setCopied] = useState(false);
  const [isChangingVideo, setIsChangingVideo] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [reactions, setReactions] = useState([]);
  const [videoInput, setVideoInput] = useState(
    initial.state.videoId ? `https://www.youtube.com/watch?v=${initial.state.videoId}` : ''
  );

  // Accurate connection and synchronization status tracking
  const [syncStatus, setSyncStatus] = useState(() => (socket?.connected ? 'in_sync' : 'connecting'));
  const messagesEndRef = useRef(null);
  const syncTimeoutRef = useRef(null);
  const playerRef = useRef(null);

  const self = useMemo(
    () => people.find((p) => p.id === initial.self.id) || initial.self,
    [people, initial.self]
  );
  const canControl = ['host', 'moderator'].includes(self.role);

  useEffect(() => {
    setActualPlaying(state.isPlaying);
  }, [state.isPlaying]);

  const isVideoPlaying = actualPlaying ?? state.isPlaying;

  // Sync scrubber current time with player tick
  useEffect(() => {
    let timer;
    if (state.isPlaying) {
      timer = setInterval(() => {
        if (playerRef.current?.getCurrentTime) {
          const t = playerRef.current.getCurrentTime();
          setCurrentTime(t);
        }
      }, 500);
    } else {
      setCurrentTime(state.currentTime);
    }
    return () => clearInterval(timer);
  }, [state.isPlaying, state.currentTime]);

  // Socket connection and synchronization state listeners
  useEffect(() => {
    if (!socket) return;

    const onConnect = () => {
      setSyncStatus('connected');
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        setSyncStatus('in_sync');
      }, 400);
    };

    const onDisconnect = () => {
      setSyncStatus('connection_lost');
    };

    const onConnectError = () => {
      setSyncStatus('reconnecting');
    };

    const onSyncState = (next) => {
      setSyncStatus('synchronizing');
      setState((old) => ({ ...old, ...next }));
      if (next.currentTime !== undefined) {
        setCurrentTime(next.currentTime);
      }
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        if (socket?.connected) {
          setSyncStatus('in_sync');
        }
      }, 500);
    };

    const onUserJoined = (data) => {
      setMessages((old) => [
        ...old,
        {
          id: `sys-join-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'A participant'} joined the room`,
          time: Date.now(),
        },
      ]);
    };

    const onUserLeft = (data) => {
      setMessages((old) => [
        ...old,
        {
          id: `sys-leave-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'A participant'} left the room`,
          time: Date.now(),
        },
      ]);
    };

    const onRoleAssigned = (data) => {
      setMessages((old) => [
        ...old,
        {
          id: `sys-role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'User'} is now ${data.role === 'host' ? 'the Host' : data.role === 'moderator' ? 'a Moderator' : 'a Participant'}`,
          time: Date.now(),
        },
      ]);
    };

    const onActionRejected = (data) => {
      setPlayerError(data.message || data.error || 'Action rejected');
    };

    const onReaction = (data) => {
      if (!data?.emoji) return;
      const rx = {
        id: data.id || `rx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        emoji: data.emoji,
        username: data.username || 'User',
        left: 15 + Math.random() * 70,
      };
      setReactions((prev) => [...prev.slice(-12), rx]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== rx.id));
      }, 2600);
    };

    const onChatRateLimited = (data) => {
      setChatError(data?.error || 'Sending messages too fast.');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('sync_state', onSyncState);
    socket.on('participants_updated', setPeople);
    socket.on('user_joined', onUserJoined);
    socket.on('user_left', onUserLeft);
    socket.on('role_assigned', onRoleAssigned);
    socket.on('action_rejected', onActionRejected);
    socket.on('reaction', onReaction);
    socket.on('chat_rate_limited', onChatRateLimited);
    socket.on('chat_message', (m) => {
      setMessages((old) => [...old, m]);
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('sync_state', onSyncState);
      socket.off('participants_updated', setPeople);
      socket.off('user_joined', onUserJoined);
      socket.off('user_left', onUserLeft);
      socket.off('role_assigned', onRoleAssigned);
      socket.off('action_rejected', onActionRejected);
      socket.off('reaction', onReaction);
      socket.off('chat_rate_limited', onChatRateLimited);
      socket.off('chat_message');
      clearTimeout(syncTimeoutRef.current);
    };
  }, [socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Playback control routing through backend-authorized socket events
  const playback = (type, time = state.currentTime) => {
    if (!canControl || !socket?.connected) return;
    setSyncStatus('synchronizing');
    socket.emit('playback', { roomId: initial.roomId, type, time });
  };

  const handlePlayPause = () => {
    const curTime = playerRef.current?.getCurrentTime?.() ?? state.currentTime;
    playback(isVideoPlaying ? 'pause' : 'play', curTime);
  };

  const sendReaction = (emoji) => {
    if (!socket?.connected) return;
    socket.emit('reaction', { roomId: initial.roomId, emoji });
  };

  const handleSeek = (delta) => {
    const curTime = playerRef.current?.getCurrentTime?.() ?? state.currentTime;
    const maxDur = duration || playerRef.current?.getDuration?.() || 86400;
    const target = Math.max(0, Math.min(maxDur, curTime + delta));
    setCurrentTime(target);
    playback('seek', target);
  };

  const changeVideo = (e) => {
    e?.preventDefault();
    if (!canControl) return;
    const id = videoIdFrom(videoInput);
    if (id) {
      setPlayerError('');
      setSyncStatus('synchronizing');
      socket.emit('playback', { roomId: initial.roomId, type: 'video', videoId: id });
      setIsChangingVideo(false);
    } else {
      setPlayerError('Please enter a valid YouTube URL (Shorts, youtu.be, watch, embed) or an 11-character video ID.');
    }
  };

  const sendChat = (e) => {
    e?.preventDefault();
    if (!socket?.connected) {
      setChatError('Cannot send message: disconnected from server.');
      return;
    }
    const cleanText = text.trim();
    if (!cleanText) return;
    if (chatError) setChatError('');
    socket.emit('chat', { roomId: initial.roomId, text: cleanText });
    setText('');
  };

  const copy = () => {
    const url = `${window.location.origin}?room=${initial.roomId}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const statusLabels = {
    connecting: 'Connecting…',
    connected: 'Connected',
    synchronizing: 'Synchronizing…',
    in_sync: 'In sync',
    reconnecting: 'Reconnecting…',
    connection_lost: 'Connection lost',
  };

  const participantCount = people.length;
  const participantWording = `${participantCount} ${participantCount === 1 ? 'participant' : 'participants'}`;

  return (
    <main className="room-shell">
      {/* Ambient background lighting for Watch Room */}
      <div className="room-ambient-bg" aria-hidden="true">
        <div className="ambient-glow room-glow-1"></div>
        <div className="ambient-glow room-glow-2"></div>
        <div className="ambient-pattern"></div>
      </div>

      {/* 1. Room Header */}
      <header className="room-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
              <polygon points="10,8 15,11 10,14" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1" />
            </svg>
          </div>
          <span className="brand-title">Syncspace</span>
        </div>

        {/* Room Code Display: format "ROOM 1K9CJJ" with separate Copy Link button */}
        <div className="room-code-group" aria-label="Room details">
          <div className="room-code-pill">
            <span className="code-prefix">ROOM</span>
            <strong className="code-string">{initial.roomId}</strong>
          </div>
          <button
            type="button"
            className="copy-link-btn"
            onClick={copy}
            aria-label="Copy shareable room URL"
            title="Copy complete room URL"
          >
            <span className="copy-icon" aria-hidden="true">
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              )}
            </span>
            <span>{copied ? 'Link Copied' : 'Copy Link'}</span>
          </button>
        </div>

        {/* Header Right Actions: Theme Toggle clearly separated from Leave Room button */}
        <div className="header-right-group">
          <div className="theme-toggle-slot">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          </div>
          <div className="header-slot-divider" aria-hidden="true"></div>
          <button
            type="button"
            className="leave-room-btn"
            onClick={() => setShowLeaveModal(true)}
            title="Leave watch party and return to landing"
            aria-label="Leave watch party"
          >
            Leave Room
          </button>
        </div>
      </header>

      {/* Leave Room Confirmation Dialog */}
      {showLeaveModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="leave-modal-title">
          <div className="modal-dialog">
            <div className="modal-header">
              <span className="modal-warning-icon" aria-hidden="true">🚪</span>
              <h3 id="leave-modal-title">Leave Watch Party?</h3>
            </div>
            <p className="modal-body">
              Are you sure you want to leave room <strong>{initial.roomId}</strong>? You can rejoin anytime using the room code or invite link.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setShowLeaveModal(false)}
                autoFocus
              >
                Stay in Room
              </button>
              <button
                type="button"
                className="modal-confirm-btn"
                onClick={() => {
                  setShowLeaveModal(false);
                  leave();
                }}
              >
                Yes, Leave Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2-Column Responsive Layout */}
      <div className="room-layout">
        {/* Main Watch Area */}
        <section className="watch-section">
          {/* 2. YouTube Video Player */}
          <div className="video-container" aria-label="YouTube Video Player">
            {state.videoId ? (
              <YouTubePlayer
                state={state}
                playerRef={playerRef}
                canControl={canControl}
                onSharedPlayback={playback}
                onTitleChange={setVideoTitle}
                onDurationChange={setDuration}
                onPlayerStateChange={(isPlaying) => setActualPlaying(isPlaying)}
                onError={(errText) => setPlayerError(errText)}
              />
            ) : (
              <div className="empty-player">
                <div className="empty-icon" aria-hidden="true">◉</div>
                <h2>Choose a video to start</h2>
                <p>Paste any YouTube URL or 11-character video ID below to start synchronized playback.</p>
              </div>
            )}

            {/* Real-time synchronized floating reactions */}
            {reactions.length > 0 && (
              <div className="reactions-overlay" aria-hidden="true">
                {reactions.map((r) => (
                  <div key={r.id} className="floating-reaction" style={{ left: `${r.left}%` }}>
                    <span className="reaction-emoji">{r.emoji}</span>
                    <span className="reaction-username">{r.username}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Video Information Section: Playback Status on its own line above Video Title */}
          {state.videoId && (
            <div className="video-info-section">
              <div className="video-status-row">
                <span className={`playback-status-pill ${isVideoPlaying ? 'status-playing' : 'status-paused'}`}>
                  <span className="playback-status-dot" aria-hidden="true"></span>
                  <strong>{isVideoPlaying ? 'PLAYING' : 'PAUSED'}</strong>
                </span>
              </div>
              <h3 className="video-title-heading">
                {videoTitle || `YouTube Video (${state.videoId})`}
              </h3>
            </div>
          )}

          {/* Playback Error Alert */}
          {playerError && (
            <div className="room-error-alert" role="alert">
              <span className="error-text">⚠️ {playerError}</span>
              <button
                type="button"
                className="dismiss-error-btn"
                onClick={() => setPlayerError('')}
                aria-label="Dismiss playback error"
              >
                ✕
              </button>
            </div>
          )}

          {/* 4. Playback Controls Toolbar: −10s, +10s, Change Video */}
          <div className="controls-toolbar" role="toolbar" aria-label="Room playback controls">
            {/* Real derived synchronization status */}
            <div
              className={`sync-status-indicator status-${syncStatus}`}
              title={`Connection & Sync Status: ${statusLabels[syncStatus]}`}
              role="status"
              aria-live="polite"
            >
              <span className="sync-status-dot" aria-hidden="true"></span>
              <span className="sync-status-label">{statusLabels[syncStatus]}</span>
            </div>

            {/* Additional Custom Controls: -10s, +10s, Change Video */}
            <div className="toolbar-buttons">
              {canControl ? (
                <>
                  <button
                    type="button"
                    className="toolbar-btn secondary-action-btn seek-btn"
                    disabled={!state.videoId || !socket?.connected}
                    onClick={() => handleSeek(-10)}
                    aria-label="Rewind 10 seconds"
                    title="Rewind 10 seconds (−10s)"
                  >
                    <span className="btn-icon" aria-hidden="true">⏪</span>
                    <span>−10s</span>
                  </button>

                  <button
                    type="button"
                    className="toolbar-btn secondary-action-btn seek-btn"
                    disabled={!state.videoId || !socket?.connected}
                    onClick={() => handleSeek(10)}
                    aria-label="Forward 10 seconds"
                    title="Forward 10 seconds (+10s)"
                  >
                    <span className="btn-icon" aria-hidden="true">⏩</span>
                    <span>+10s</span>
                  </button>

                  <button
                    type="button"
                    className={`toolbar-btn change-video-toggle-btn ${isChangingVideo ? 'active' : ''}`}
                    disabled={!socket?.connected}
                    onClick={() => setIsChangingVideo((prev) => !prev)}
                    aria-expanded={isChangingVideo}
                    aria-label="Toggle change video input"
                    title="Change room video"
                  >
                    <span className="btn-icon" aria-hidden="true">📺</span>
                    <span>Change Video</span>
                  </button>
                </>
              ) : (
                <div className="participant-control-notice">
                  <span>🔒 Playback controlled by Host &amp; Moderators</span>
                </div>
              )}
            </div>
          </div>

          {/* Expandable Change Video Panel */}
          {canControl && isChangingVideo && (
            <form className="change-video-panel" onSubmit={changeVideo}>
              <div className="change-input-wrap">
                <input
                  type="text"
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                  placeholder="Paste YouTube link (watch, shorts, embed, youtu.be, or video ID)..."
                  className="change-video-text-input"
                  autoFocus
                />
              </div>
              <div className="change-actions-wrap">
                <button type="submit" className="confirm-change-btn">
                  Load Video
                </button>
                <button
                  type="button"
                  className="cancel-change-btn"
                  onClick={() => setIsChangingVideo(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Sidebar: 4. Participants Panel & 5. Room Chat */}
        <aside className="room-sidebar">
          {/* 4. Participants Panel */}
          <section className="sidebar-card people-card" aria-label="Room participants">
            <div className="sidebar-card-header">
              <h2>Participants</h2>
              <span className="count-badge">{participantWording}</span>
            </div>

            <div className="people-list">
              {people.map((person) => {
                const isSelf = person.id === self.id;
                const isHost = self.role === 'host';
                return (
                  <div className="person-row" key={person.id}>
                    <div className="person-avatar" aria-hidden="true">
                      {person.username[0]?.toUpperCase() || '?'}
                    </div>

                    <div className="person-details">
                      <div className="person-name-line">
                        <strong className="person-name">{person.username}</strong>
                        {isSelf && <span className="you-indicator">You</span>}
                        <span className={`role-badge role-${person.role}`}>
                          {person.role === 'host' ? 'Host' : person.role === 'moderator' ? 'Moderator' : 'Participant'}
                        </span>
                      </div>
                    </div>

                    {isHost && !isSelf && (
                      <div className="host-management-actions">
                        <button
                          type="button"
                          className="role-action-btn"
                          onClick={() =>
                            socket.emit('assign_role', {
                              roomId: initial.roomId,
                              userId: person.id,
                              role: person.role === 'moderator' ? 'participant' : 'moderator',
                            })
                          }
                          title={person.role === 'moderator' ? 'Demote to participant' : 'Promote to moderator'}
                        >
                          {person.role === 'moderator' ? 'Demote' : 'Make mod'}
                        </button>
                        <button
                          type="button"
                          className="role-action-btn transfer-action-btn"
                          onClick={() =>
                            socket.emit('transfer_host', {
                              roomId: initial.roomId,
                              userId: person.id,
                            })
                          }
                          title={`Transfer host ownership to ${person.username}`}
                        >
                          Make Host
                        </button>
                        <button
                          type="button"
                          className="remove-action-btn"
                          onClick={() =>
                            socket.emit('remove_participant', {
                              roomId: initial.roomId,
                              userId: person.id,
                            })
                          }
                          title={`Remove ${person.username} from room`}
                          aria-label={`Remove ${person.username}`}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 5. Room Chat Panel */}
          <section className="sidebar-card chat-card" aria-label="Room chat">
            <div className="sidebar-card-header chat-card-header">
              <div className="chat-header-title">
                <svg className="chat-title-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <h2>Room Chat</h2>
              </div>
              <div className="chat-header-status">
                {socket?.connected ? (
                  <span className="chat-live-badge" title="Chat live">
                    <span className="chat-live-dot" aria-hidden="true"></span>
                    <span>Live</span>
                  </span>
                ) : (
                  <span className="chat-offline-badge">Offline</span>
                )}
              </div>
            </div>

            <div className="chat-messages-container" aria-live="polite">
              {messages.length ? (
                messages.map((m) => {
                  if (m.isSystem) {
                    return (
                      <div className="chat-system-message" key={m.id}>
                        <span className="chat-system-text">{m.text}</span>
                      </div>
                    );
                  }
                  const isSelf = m.username?.toLowerCase() === self.username?.toLowerCase();
                  const timeFormatted = m.time
                    ? new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';
                  return (
                    <div
                      className={`chat-message-bubble ${isSelf ? 'bubble-self' : 'bubble-other'}`}
                      key={m.id}
                    >
                      <div className="message-header-line">
                        <strong className="message-sender">{isSelf ? 'You' : m.username}</strong>
                        {timeFormatted && <span className="message-timestamp">{timeFormatted}</span>}
                      </div>
                      <p className="message-text-content">{m.text}</p>
                    </div>
                  );
                })
              ) : (
                <div className="chat-empty-notice">
                  <div className="empty-chat-icon-ring" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                      <circle cx="9" cy="10" r="1" fill="currentColor"></circle>
                      <circle cx="12" cy="10" r="1" fill="currentColor"></circle>
                      <circle cx="15" cy="10" r="1" fill="currentColor"></circle>
                    </svg>
                  </div>
                  <strong className="empty-chat-lead">No messages yet</strong>
                  <p className="empty-chat-sub">Start the conversation! Send a message to everyone in this room.</p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Synchronized Emoji Reactions */}
            <div className="chat-reactions-toolbar" aria-label="Room reactions">
              {['🔥', '❤️', '😂', '👏', '🎉', '😮'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="quick-reaction-btn"
                  onClick={() => sendReaction(emoji)}
                  disabled={!socket?.connected}
                  title={`React with ${emoji}`}
                  aria-label={`Send reaction ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>

            <form className="chat-input-form" onSubmit={sendChat}>
              <div className="chat-input-wrapper">
                <textarea
                  rows={1}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (chatError) setChatError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendChat(e);
                    }
                  }}
                  placeholder={socket?.connected ? 'Type a message…' : 'Reconnecting to chat...'}
                  disabled={!socket?.connected}
                  className="chat-textarea-input"
                  maxLength={500}
                  aria-label="Type a message"
                />
              </div>
              <button
                type="submit"
                className="chat-send-action-btn"
                disabled={!socket?.connected || !text.trim()}
                aria-label="Send message"
                title="Send message (Enter)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            </form>
            {chatError && (
              <div className="chat-error-notice" role="alert">
                <span>⚠️ {chatError}</span>
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function YouTubePlayer({
  state,
  playerRef,
  canControl,
  onSharedPlayback,
  onTitleChange,
  onDurationChange,
  onPlayerStateChange,
  onError,
}) {
  const mount = useRef(null);
  const player = useRef(null);
  const ready = useRef(false);
  const activeVideoId = useRef('');
  const isApplying = useRef(false);
  const latestState = useRef(state);
  latestState.current = state;
  const latestCanControl = useRef(canControl);
  latestCanControl.current = canControl;

  useEffect(() => {
    const fetchMeta = (instance) => {
      try {
        const title = instance?.getVideoData?.()?.title;
        if (title) onTitleChange(title);
        const dur = instance?.getDuration?.();
        if (dur) onDurationChange?.(dur);
      } catch {
        // Safe fallback
      }
    };

    const create = () => {
      if (!mount.current || player.current || !window.YT?.Player) return;
      player.current = new window.YT.Player(mount.current, {
        videoId: latestState.current.videoId,
        playerVars: {
          controls: 1, // Preserve native YouTube controls: fullscreen, subtitles/captions, quality
          fs: 1, // Enable native fullscreen button
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            ready.current = true;
            if (playerRef) playerRef.current = event.target;
            const iframe = event.target?.getIframe?.();
            if (iframe) {
              iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen');
              iframe.setAttribute('allowfullscreen', 'true');
            }
            fetchMeta(event.target);
            apply(latestState.current);
          },
          onStateChange: (event) => {
            fetchMeta(event.target);
            const instance = event.target;
            const curState = latestState.current;
            const hasControl = latestCanControl.current;

            // YouTube Player State: 1 = PLAYING, 2 = PAUSED
            if (event?.data === 1) {
              onPlayerStateChange?.(true);
              if (!isApplying.current) {
                if (hasControl) {
                  if (!curState.isPlaying) {
                    onSharedPlayback?.('play', instance.getCurrentTime?.() ?? curState.currentTime);
                  }
                } else {
                  // Participant attempted to play while room is paused: snap back to authoritative room state
                  if (!curState.isPlaying) {
                    instance.pauseVideo();
                  }
                }
              }
            } else if (event?.data === 2) {
              onPlayerStateChange?.(false);
              if (!isApplying.current) {
                if (hasControl) {
                  if (curState.isPlaying) {
                    onSharedPlayback?.('pause', instance.getCurrentTime?.() ?? curState.currentTime);
                  }
                } else {
                  // Participant attempted to pause while room is playing: snap back to authoritative room state
                  if (curState.isPlaying) {
                    instance.playVideo();
                  }
                }
              }
            }
          },
          onError: (event) => {
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
      document.head.appendChild(script);
    }

    return () => {
      window.onYouTubeIframeAPIReady = old;
      ready.current = false;
      player.current?.destroy();
      player.current = null;
      if (playerRef) playerRef.current = null;
    };
  }, []);

  const apply = (next) => {
    const instance = player.current;
    if (!ready.current || !instance) return;

    if (activeVideoId.current !== next.videoId) {
      activeVideoId.current = next.videoId;
      isApplying.current = true;
      const options = { videoId: next.videoId, startSeconds: next.currentTime };
      if (next.isPlaying) {
        instance.loadVideoById(options);
      } else {
        instance.cueVideoById(options);
      }
      setTimeout(() => {
        isApplying.current = false;
        try {
          const t = instance.getVideoData?.()?.title;
          if (t) onTitleChange(t);
          const dur = instance.getDuration?.();
          if (dur) onDurationChange?.(dur);
        } catch {}
      }, 700);
      return;
    }

    const currentTime = instance.getCurrentTime?.() || 0;
    if (Math.abs(currentTime - next.currentTime) > 1.0) {
      instance.seekTo(next.currentTime, true);
    }

    isApplying.current = true;
    if (next.isPlaying) {
      instance.playVideo();
    } else {
      instance.pauseVideo();
    }
    setTimeout(() => {
      isApplying.current = false;
    }, 400);
  };

  useEffect(() => {
    apply(state);
  }, [state.videoId, state.currentTime, state.isPlaying]);

  return <div className="youtube-player" ref={mount} />;
}
