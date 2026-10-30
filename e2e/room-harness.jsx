import React from 'react';
import { createRoot } from 'react-dom/client';
import { Room } from '../src/Room.jsx';

export function mountRoomHarness() {
  const element = document.createElement('div');
  element.id = 'room-harness';
  document.body.append(element);

  const listeners = new Map();
  const playbackAcks = [];
  const socket = {
    connected: true,
    on(event, listener) {
      const callbacks = listeners.get(event) || [];
      callbacks.push(listener);
      listeners.set(event, callbacks);
    },
    off(event, listener) {
      if (!listener) {
        listeners.delete(event);
        return;
      }
      listeners.set(event, (listeners.get(event) || []).filter((item) => item !== listener));
    },
    emit(event, ...args) {
      if (event === 'playback') playbackAcks.push({ data: args[0], acknowledge: args[1] });
    },
    dispatch(event, data) {
      (listeners.get(event) || []).slice().forEach((listener) => listener(data));
    },
    setConnected(connected) {
      this.connected = connected;
      this.dispatch(connected ? 'connect' : 'disconnect', 'test connection change');
    },
  };

  const self = {
    id: 'test-host',
    username: 'TestHost',
    role: 'host',
    connected: true,
  };
  const initial = {
    roomId: 'ROOM01',
    self,
    participants: [self],
    pendingPlaybackRequests: [],
    state: {
      videoId: 'dQw4w9WgXcQ',
      currentTime: 0,
      isPlaying: false,
      revision: 10,
    },
  };
  const root = createRoot(element);
  root.render(
    <Room
      socket={socket}
      initial={initial}
      leave={() => {}}
      theme="dark"
      toggleTheme={() => {}}
    />
  );

  return {
    socket,
    playbackAcks,
    acknowledge(index, result) {
      playbackAcks[index]?.acknowledge?.(result);
    },
    cleanup() {
      root.unmount();
      element.remove();
    },
  };
}
