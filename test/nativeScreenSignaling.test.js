'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNativeScreenSignaling } = require('../src/socketHandlers/nativeScreen');
const registerVoiceHandlers = require('../src/socketHandlers/voice');

function createHarness({ senderId = 1, sharerId = 1, offerWindows = new Map() } = {}) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: `socket-${senderId}`,
    user: { id: senderId, displayName: `User ${senderId}` },
    on(event, handler) { handlers.set(event, handler); },
  };
  const room = new Map([
    [1, { id: 1, socketId: 'socket-1' }],
    [2, { id: 2, socketId: 'socket-2' }],
  ]);
  const io = {
    to(socketId) {
      return { emit(event, payload) { emitted.push({ socketId, event, payload }); } };
    },
  };
  registerNativeScreenSignaling(socket, {
    io,
    voiceUsers: new Map([['a1b2c3d4', room]]),
    activeScreenSharers: new Map([['a1b2c3d4', new Set([sharerId])]]),
    activeScreenSessions: new Map([['a1b2c3d4', new Map([[
      sharerId,
      { transport: 'native', sessionId: 'native-session-1234' },
    ]])]]),
    nativeScreenOfferWindows: offerWindows,
  });
  return { handlers, emitted };
}

const base = {
  code: 'a1b2c3d4',
  targetUserId: 2,
  sessionId: 'native-session-1234',
  negotiationId: 'negotiation-1234',
};

test('relays native screen offers only from the active sharer', () => {
  const accepted = createHarness();
  accepted.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: 'v=0' },
  });
  assert.deepEqual(accepted.emitted, [{
    socketId: 'socket-2',
    event: 'native-screen-offer',
    payload: {
      from: { id: 1, username: 'User 1' },
      channelCode: 'a1b2c3d4',
      sessionId: 'native-session-1234',
      negotiationId: 'negotiation-1234',
      offer: { type: 'offer', sdp: 'v=0' },
    },
  }]);

  const rejected = createHarness({ sharerId: 2 });
  rejected.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: 'v=0' },
  });
  assert.equal(rejected.emitted.length, 0);
});

test('rate limits repeated native offers to the same viewer', () => {
  const harness = createHarness();
  for (let index = 0; index < 12; index++) {
    harness.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
  }
  assert.equal(harness.emitted.length, 8);
});

test('native offer rate limits survive sender reconnection', () => {
  const offerWindows = new Map();
  const first = createHarness({ offerWindows });
  const second = createHarness({ offerWindows });
  for (let index = 0; index < 6; index++) {
    first.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `first-negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
    second.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `second-negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
  }
  assert.equal(first.emitted.length + second.emitted.length, 8);
});

test('relays native screen answers only to the active sharer', () => {
  const accepted = createHarness({ senderId: 2, sharerId: 1 });
  accepted.handlers.get('native-screen-answer')({
    ...base,
    targetUserId: 1,
    answer: { type: 'answer', sdp: 'v=0' },
  });
  assert.equal(accepted.emitted.length, 1);
  assert.equal(accepted.emitted[0].socketId, 'socket-1');

  const rejected = createHarness({ senderId: 2, sharerId: 2 });
  rejected.handlers.get('native-screen-answer')({
    ...base,
    targetUserId: 1,
    answer: { type: 'answer', sdp: 'v=0' },
  });
  assert.equal(rejected.emitted.length, 0);
});

test('relays ICE in either direction and rejects stale session identifiers', () => {
  const viewer = createHarness({ senderId: 2, sharerId: 1 });
  viewer.handlers.get('native-screen-ice-candidate')({
    ...base,
    targetUserId: 1,
    candidate: { candidate: 'candidate:1', sdpMid: 'video0', sdpMLineIndex: 0 },
  });
  assert.equal(viewer.emitted.length, 1);

  const stale = createHarness();
  stale.handlers.get('native-screen-ice-candidate')({
    ...base,
    sessionId: 'native-session-old1',
    candidate: null,
  });
  assert.equal(stale.emitted.length, 0);
});

function createLifecycleHarness({ socketId = 'socket-1', ownerSocketId = 'socket-1' } = {}) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: socketId,
    user: { id: 1, username: 'User 1', displayName: 'User 1', isAdmin: false },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ socketId, event, payload }); },
    join() {},
    leave() {},
  };
  const state = {
    channelUsers: new Map(),
    voiceUsers: new Map([['a1b2c3d4', new Map([
      [1, { id: 1, username: 'User 1', socketId: ownerSocketId }],
      [2, { id: 2, username: 'User 2', socketId: 'socket-2' }],
    ])]]),
    voiceLastActivity: new Map(),
    activeMusic: new Map(),
    activeScreenSharers: new Map(),
    activeScreenSessions: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingTempDelete: new Map(),
    pendingVoiceLeave: new Map(),
  };
  const chain = {
    to() { return chain; },
    emit(event, payload) { emitted.push({ socketId: 'room', event, payload }); },
  };
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        to() { return chain; },
        emit(event, payload) { emitted.push({ socketId: target, event, payload }); },
      };
    },
  };
  const db = {
    prepare() {
      return {
        get() { return { streams_enabled: 1, voice_bitrate: 0 }; },
        all() { return []; },
        run() {},
      };
    },
  };
  registerVoiceHandlers(socket, {
    io,
    db,
    state,
    userHasPermission: () => true,
    getUserEffectiveLevel: () => 0,
    getUserHighestRole: () => null,
    broadcastVoiceUsers() {},
    emitOnlineUsers() {},
    handleVoiceLeave() {},
    touchVoiceActivity() {},
    pruneStaleVoiceUsers() {},
    getMentionableChannelMembers: () => [],
    getActiveMusicSyncState: () => null,
    getMusicQueuePayload: () => [],
  });
  return { handlers, emitted, state };
}

test('screen lifecycle requires the socket that owns the voice entry', () => {
  const { handlers, state } = createLifecycleHarness({
    socketId: 'socket-old',
    ownerSocketId: 'socket-new',
  });
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
  });
  assert.equal(state.activeScreenSessions.size, 0);
});

test('a stale native stop cannot remove a newer screen session', () => {
  const { handlers, state } = createLifecycleHarness();
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
  });
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-old1',
  });
  assert.equal(
    state.activeScreenSessions.get('a1b2c3d4').get(1).sessionId,
    'native-session-1234'
  );
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-1234',
  });
  assert.equal(state.activeScreenSessions.size, 0);
});

test('a stale native stop cannot remove a newer browser screen session', () => {
  const { handlers, state } = createLifecycleHarness();
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
  });
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'browser',
  });
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-1234',
  });

  assert.equal(
    state.activeScreenSessions.get('a1b2c3d4').get(1).transport,
    'browser'
  );
});

test('voice join and no-op rejoin always emit authoritative screen snapshots', () => {
  const harness = createLifecycleHarness();
  harness.handlers.get('voice-join')({ code: 'a1b2c3d4' });
  const joinSnapshot = harness.emitted.find(item => item.event === 'active-screen-sharers');
  assert.deepEqual(joinSnapshot.payload, { channelCode: 'a1b2c3d4', sharers: [] });

  harness.emitted.length = 0;
  harness.handlers.get('voice-rejoin')({ code: 'a1b2c3d4' });
  const rejoinSnapshot = harness.emitted.find(item => item.event === 'active-screen-sharers');
  assert.deepEqual(rejoinSnapshot.payload, { channelCode: 'a1b2c3d4', sharers: [] });
});
