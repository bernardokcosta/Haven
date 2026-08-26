'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/voice.js'),
  'utf8'
);

function loadVoiceManager(globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    ...globals,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, {
    filename: 'voice.js',
  });
  return context.module.exports;
}

function completeNativeApi(overrides = {}) {
  return {
    getCapabilities: async () => ({ supported: true }),
    start: async () => ({ started: true, sessionId: 'native-session-1234' }),
    stop: async () => {},
    addPeer: async () => {},
    removePeer: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    onSignal() {},
    ...overrides,
  };
}

test('native screen start is transactional when the helper returns invalid state', async () => {
  let stopCalls = 0;
  const api = completeNativeApi({
    start: async () => ({ started: true, sessionId: '../invalid' }),
    stop: async () => { stopCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    currentChannel: 'a1b2c3d4',
    inVoice: true,
    socket: { emit() {} },
  });

  assert.equal(await voice._tryStartNativeScreenShare(), null);
  assert.equal(stopCalls, 1);
  assert.notEqual(voice._nativeScreenSharing, true);
});

test('native picker cancellation does not fall through to another picker', async () => {
  const api = completeNativeApi({
    start: async () => ({ started: false, cancelled: true }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    currentChannel: 'a1b2c3d4',
    inVoice: true,
    socket: { emit() {} },
  });

  assert.equal(await voice._tryStartNativeScreenShare(), false);
});

test('rebuilding a voice peer does not tear down its independent native screen peer', () => {
  let closed = 0;
  let nativeCloseCalls = 0;
  let nativeRemoveCalls = 0;
  const api = completeNativeApi({ removePeer: async () => { nativeRemoveCalls++; } });
  const VoiceManager = loadVoiceManager({
    window: { havenDesktop: { nativeScreen: api } },
    document: { getElementById: () => null },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    peers: new Map([[7, { connection: { close: () => { closed++; } } }]]),
    gainNodes: new Map(),
    screenGainNodes: new Map(),
    _screenDelivered: new Set(),
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _closeNativeScreenPeer: () => { nativeCloseCalls++; },
    _stopAnalyser() {},
  });

  voice._removePeer(7);

  assert.equal(closed, 1);
  assert.equal(nativeCloseCalls, 0);
  assert.equal(nativeRemoveCalls, 0);
});

test('native receiver drains ICE that arrives while applying the offer', async () => {
  let releaseRemoteDescription;
  const addedCandidates = [];
  class FakePeerConnection {
    constructor() {
      this.remoteDescription = null;
      this.connectionState = 'new';
    }
    setRemoteDescription() {
      return new Promise(resolve => {
        releaseRemoteDescription = () => {
          this.remoteDescription = { type: 'offer' };
          resolve();
        };
      });
    }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() {}
    async addIceCandidate(candidate) { addedCandidates.push(candidate); }
    close() {}
  }
  const emitted = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    currentChannel: 'a1b2c3d4',
    rtcConfig: {},
    screenSharers: new Set([7]),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    socket: { emit: (event, payload) => emitted.push({ event, payload }) },
  });

  const offerPromise = voice._handleNativeScreenOffer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    offer: { type: 'offer', sdp: 'v=0' },
  });
  await Promise.resolve();
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: { candidate: 'candidate:1' },
  });
  releaseRemoteDescription();
  await offerPromise;

  assert.deepEqual(addedCandidates, [{ candidate: 'candidate:1' }]);
  assert.equal(emitted.at(-1).event, 'native-screen-answer');
});

test('fatal helper errors without a peer stop the native share', async () => {
  let signalHandler;
  let stopCalls = 0;
  const api = completeNativeApi({
    onSignal: handler => { signalHandler = handler; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    currentChannel: 'a1b2c3d4',
    socket: { emit() {} },
    stopScreenShare: async () => { stopCalls++; },
  });

  voice._setupNativeScreenBridge();
  signalHandler({
    type: 'error',
    sessionId: 'native-session-1234',
    peerId: null,
    message: 'pipeline failed',
    fatal: true,
  });
  await Promise.resolve();

  assert.equal(stopCalls, 1);
});

test('sender queues native ICE until the browser answer is applied', async () => {
  let releaseAnswer;
  const calls = [];
  const api = completeNativeApi({
    setRemoteDescription: async () => {
      calls.push('answer-start');
      await new Promise(resolve => { releaseAnswer = resolve; });
      calls.push('answer-done');
    },
    addIceCandidate: async ({ candidate }) => {
      calls.push(candidate ? candidate.candidate : 'end-of-candidates');
    },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map([[
      '7:native-session-1234:negotiation-1234',
      { ready: false, applying: null, candidates: [] },
    ]]),
    currentChannel: 'a1b2c3d4',
  });

  const answer = voice._handleNativeScreenAnswer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    answer: { type: 'answer', sdp: 'v=0' },
  });
  await Promise.resolve();
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: { candidate: 'candidate:1' },
  });
  await voice._handleNativeScreenIceCandidate({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    candidate: null,
  });
  assert.deepEqual(calls, ['answer-start']);
  releaseAnswer();
  await answer;
  assert.deepEqual(calls, ['answer-start', 'answer-done', 'candidate:1', 'end-of-candidates']);
});

test('native start is stopped without announcement after leaving during the picker', async () => {
  let resolveStart;
  let stopCalls = 0;
  const emitted = [];
  const api = completeNativeApi({
    start: () => new Promise(resolve => { resolveStart = resolve; }),
    stop: async () => { stopCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    socket: { emit: (event, payload) => emitted.push({ event, payload }) },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolveStart({ started: true, sessionId: 'native-session-1234' });

  assert.equal(await pending, false);
  assert.equal(stopCalls, 1);
  assert.equal(emitted.length, 0);
  assert.notEqual(voice._nativeScreenSharing, true);
});

test('stale native answers cannot replace the current viewer negotiation', async () => {
  let applyCalls = 0;
  const api = completeNativeApi({
    setRemoteDescription: async () => { applyCalls++; },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map([[
      '7:native-session-1234:negotiation-current',
      { ready: false, applying: null, candidates: [] },
    ]]),
    currentChannel: 'a1b2c3d4',
  });

  await voice._handleNativeScreenAnswer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-stale',
    answer: { type: 'answer', sdp: 'v=0' },
  });

  assert.equal(applyCalls, 0);
});

test('an empty screen snapshot removes stale local sharers', () => {
  const handlers = new Map();
  const removed = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    screenSharers: new Set([7]),
    webcamUsers: new Set(),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({ channelCode: 'a1b2c3d4', sharers: [] });

  assert.equal(voice.screenSharers.size, 0);
  assert.equal(voice._nativeScreenAnnouncements.size, 0);
  assert.deepEqual(removed, [{ userId: 7, stream: null }]);
});

test('an empty recovery snapshot preserves an active local share', () => {
  const handlers = new Map();
  const removed = [];
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    isScreenSharing: true,
    screenSharers: new Set([1]),
    webcamUsers: new Set(),
    _screenDelivered: new Set([1]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
  });
  voice._setupSocketListeners();

  handlers.get('active-screen-sharers')({ channelCode: 'a1b2c3d4', sharers: [] });

  assert.equal(voice.screenSharers.has(1), true);
  assert.equal(removed.length, 0);
});

test('browser screen sharing is reannounced after voice rejoin', async () => {
  const emitted = [];
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: false,
    currentChannel: 'a1b2c3d4',
    screenStream: { getAudioTracks: () => [{}] },
    socket: { emit: (event, payload) => emitted.push({ event, payload }) },
  });

  await voice._reannounceScreenShare([]);

  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{
    event: 'screen-share-started',
    payload: { code: 'a1b2c3d4', hasAudio: true, transport: 'browser' },
  }]);
});

test('unknown native ICE negotiations are bounded per sharer session', async () => {
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    _nativeScreenSharing: false,
    currentChannel: 'a1b2c3d4',
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
  });

  for (let index = 0; index < 10; index++) {
    await voice._handleNativeScreenIceCandidate({
      from: { id: 7 },
      channelCode: 'a1b2c3d4',
      sessionId: 'native-session-1234',
      negotiationId: `negotiation-${index}`,
      candidate: { candidate: `candidate:${index}` },
    });
  }

  assert.equal(voice._pendingNativeScreenCandidates.size, 4);
});

test('native peer recovery clears stale UI and rearms retries', () => {
  const removed = [];
  let requested = 0;
  let watched = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    screenSharers: new Set([7]),
    _screenDelivered: new Set([7]),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _screenWatchdogTimers: new Map(),
    onScreenStream: (userId, stream) => removed.push({ userId, stream }),
    requestScreenStream: () => { requested++; },
    _watchForScreenStream: () => { watched++; },
  });

  voice._recoverNativeScreenPeer(7);

  assert.equal(voice._screenDelivered.has(7), false);
  assert.deepEqual(removed, [{ userId: 7, stream: null }]);
  assert.equal(requested, 1);
  assert.equal(watched, 1);
});

test('a no-op voice rejoin does not churn native screen peers', async () => {
  const handlers = new Map();
  let reannounced = 0;
  const VoiceManager = loadVoiceManager({
    window: {},
    document: { querySelectorAll: () => [] },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    socket: { on: (event, handler) => handlers.set(event, handler) },
    peers: new Map(),
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 2,
    _reannounceScreenShare: async () => { reannounced++; },
    _rearmScreenWatchdogs() {},
  });
  voice._setupSocketListeners();

  await handlers.get('voice-existing-users')({
    channelCode: 'a1b2c3d4',
    users: [],
    rejoin: true,
    skipRenegotiate: true,
  });

  assert.equal(reannounced, 0);
});

test('native start revalidates voice ownership after attaching initial peers', async () => {
  let resolvePeer;
  const stops = [];
  const emitted = [];
  const api = completeNativeApi({
    addPeer: () => new Promise(resolve => { resolvePeer = resolve; }),
    stop: async data => { stops.push(data); },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    _nativeScreenSenderStates: new Map(),
    socket: { emit: (event, payload) => emitted.push({ event, payload }) },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolvePeer();

  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
  assert.equal(emitted.at(-1).event, 'screen-share-stopped');
  assert.equal(voice.isScreenSharing, false);
});

test('fatal helper failure invalidates a start waiting on initial peers', async () => {
  let resolvePeer;
  const api = completeNativeApi({
    addPeer: () => new Promise(resolve => { resolvePeer = resolve; }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    localUserId: 1,
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    screenSharers: new Set(),
    _nativeScreenAnnouncements: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: { emit() {} },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice._handleNativeScreenFailure('pipeline failed');
  await new Promise(resolve => setImmediate(resolve));
  resolvePeer();

  assert.equal(await pending, false);
  assert.equal(voice.isScreenSharing, false);
});

test('an ended native track uses the retrying recovery path', async () => {
  let connection;
  class FakePeerConnection {
    constructor() {
      connection = this;
      this.connectionState = 'new';
      this.remoteDescription = null;
    }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() {}
    close() {}
  }
  const VoiceManager = loadVoiceManager({
    window: {},
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
  });
  const voice = Object.create(VoiceManager.prototype);
  let recoveries = 0;
  Object.assign(voice, {
    currentChannel: 'a1b2c3d4',
    rtcConfig: {},
    screenSharers: new Set([7]),
    _screenDelivered: new Set(),
    _nativeScreenPeers: new Map(),
    _pendingNativeScreenCandidates: new Map(),
    _nativeScreenAnnouncements: new Map([[7, 'native-session-1234']]),
    _recoverNativeScreenPeer: () => { recoveries++; },
    socket: { emit() {} },
  });
  await voice._handleNativeScreenOffer({
    from: { id: 7 },
    channelCode: 'a1b2c3d4',
    sessionId: 'native-session-1234',
    negotiationId: 'negotiation-1234',
    offer: { type: 'offer', sdp: 'v=0' },
  });
  const track = { kind: 'video' };
  connection.ontrack({ track, streams: [{}] });
  track.onended();

  assert.equal(recoveries, 1);
});

test('stopping a native share removes a local snapshot badge', async () => {
  const api = completeNativeApi();
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    localUserId: 1,
    currentChannel: 'a1b2c3d4',
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenSenderStates: new Map(),
    screenSharers: new Set([1]),
    _nativeScreenAnnouncements: new Map([[1, 'native-session-1234']]),
    socket: { emit() {} },
  });

  await voice.stopScreenShare();

  assert.equal(voice.screenSharers.has(1), false);
  assert.equal(voice._nativeScreenAnnouncements.has(1), false);
});

test('browser fallback revalidates the voice operation after renegotiation', async () => {
  let resolveRenegotiation;
  const videoTrack = { kind: 'video', readyState: 'live', stop() {} };
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
  };
  const VoiceManager = loadVoiceManager({
    window: {},
    navigator: {
      userAgent: '', platform: '', maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia: async () => stream },
    },
  });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: false,
    isScreenSharing: false,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {
      connection: { addTrack() {} },
    }]]),
    socket: { emit() {} },
    _applyScreenBitrate() {},
    _renegotiate: () => new Promise(resolve => { resolveRenegotiation = resolve; }),
  });

  const pending = voice.shareScreen();
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolveRenegotiation();

  assert.equal(await pending, false);
});
