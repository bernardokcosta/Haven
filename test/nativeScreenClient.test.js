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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map(),
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map(),
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map(),
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

test('a rejected browser reannouncement rolls back the local share', async () => {
  let stopped = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: false,
    _nativeScreenServerVersion: 1,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    screenStream: { getAudioTracks: () => [] },
    socket: {
      emit(event, payload, callback) {
        if (event === 'screen-share-started') callback?.({ ok: false, error: 'not-owner' });
      },
    },
    stopScreenShare: async () => { stopped++; },
  });

  await voice._reannounceScreenShare([], {
    channelCode: 'a1b2c3d4',
    voiceGeneration: 3,
  });

  assert.equal(stopped, 1);
});

test('a hung native peer replacement stops the share without blocking rejoin', async () => {
  let stopCalls = 0;
  const api = completeNativeApi({
    removePeer: () => new Promise(() => {}),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenServerVersion: 1,
    _nativeScreenSenderStates: new Map(),
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
    _runNativeOperation(operation, timeoutMs) {
      return VoiceManager.prototype._runNativeOperation.call(this, operation, Math.min(timeoutMs || 3000, 10));
    },
    stopScreenShare: async () => { stopCalls++; },
  });

  await voice._reannounceScreenShare([{ id: 7 }], {
    channelCode: 'a1b2c3d4',
    voiceGeneration: 3,
  });
  await Promise.resolve();

  assert.equal(stopCalls, 1);
});

test('a stale native reannouncement failure does not stop a newer share', async () => {
  let rejectRemoval;
  let stopCalls = 0;
  const api = completeNativeApi({
    removePeer: () => new Promise((resolve, reject) => { rejectRemoval = reject; }),
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: true,
    _nativeScreenSessionId: 'native-session-1234',
    _nativeScreenServerVersion: 1,
    _nativeScreenSenderStates: new Map(),
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
    stopScreenShare: async () => { stopCalls++; },
  });

  const pending = voice._reannounceScreenShare([{ id: 7 }], {
    channelCode: 'a1b2c3d4',
    voiceGeneration: 3,
  });
  await new Promise(resolve => setImmediate(resolve));
  voice._nativeScreenSessionId = 'native-session-new2';
  rejectRemoval(new Error('old helper failed'));
  await pending;

  assert.equal(voice._nativeScreenSessionId, 'native-session-new2');
  assert.equal(stopCalls, 0);
});

test('a stale browser reannouncement rejection does not stop a newer stream', async () => {
  let acknowledge;
  let stopCalls = 0;
  const oldStream = { getAudioTracks: () => [] };
  const newStream = { getAudioTracks: () => [] };
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: true,
    _nativeScreenSharing: false,
    _nativeScreenServerVersion: 1,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    screenStream: oldStream,
    socket: {
      emit(event, payload, callback) { acknowledge = callback; },
    },
    stopScreenShare: async () => { stopCalls++; },
  });

  const pending = voice._reannounceScreenShare([], {
    channelCode: 'a1b2c3d4',
    voiceGeneration: 3,
  });
  voice.screenStream = newStream;
  acknowledge({ ok: false, error: 'old-session' });
  await pending;

  assert.equal(voice.screenStream, newStream);
  assert.equal(stopCalls, 0);
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) {
        emitted.push({ event, payload });
        if (event === 'screen-share-started' || event === 'screen-share-stopped') callback?.({ ok: true });
      },
    },
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    screenSharers: new Set(),
    _nativeScreenAnnouncements: new Map(),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) {
        if (event === 'screen-share-started' || event === 'screen-share-stopped') callback?.({ ok: true });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice._handleNativeScreenFailure('pipeline failed');
  await new Promise(resolve => setImmediate(resolve));
  resolvePeer();

  assert.equal(await pending, false);
  assert.equal(voice.isScreenSharing, false);
});

test('native start cleans both channel codes when rotation happens after announcement', async () => {
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) {
        emitted.push({ event, payload });
        if (event === 'screen-share-started' || event === 'screen-share-stopped') callback?.({ ok: true });
      },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice.currentChannel = 'e5f6a7b8';
  resolvePeer();

  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
  const stoppedCodes = emitted
    .filter(item => item.event === 'screen-share-stopped')
    .map(item => item.payload.code);
  assert.deepEqual(stoppedCodes, ['a1b2c3d4', 'e5f6a7b8']);
});

test('native transport falls back before opening the picker on an older server', async () => {
  let starts = 0;
  const api = completeNativeApi({ start: async () => { starts++; } });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    peers: new Map(),
    _nativeScreenServerVersion: 0,
    _nativeScreenPeerVersions: new Map(),
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), null);
  assert.equal(starts, 0);
});

test('native startup times out and cleans up when a viewer attachment hangs', async () => {
  let stopCalls = 0;
  const api = completeNativeApi({
    addPeer: () => new Promise(() => {}),
    stop: () => {
      stopCalls++;
      return new Promise(() => {});
    },
  });
  const VoiceManager = loadVoiceManager({ window: { havenDesktop: { nativeScreen: api } } });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    inVoice: true,
    currentChannel: 'a1b2c3d4',
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _nativeScreenPeerAttachTimeoutMs: 10,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map([[7, {}]]),
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    _nativeScreenSenderStates: new Map(),
    _runNativeOperation(operation, timeoutMs) {
      return VoiceManager.prototype._runNativeOperation.call(this, operation, Math.min(timeoutMs || 3000, 10));
    },
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), false);
  assert.equal(stopCalls, 1);
  assert.equal(voice.isScreenSharing, false);
});

test('a stale native startup failure cannot clear a newer session', async () => {
  let rejectPeer;
  const stops = [];
  const api = completeNativeApi({
    addPeer: () => new Promise((resolve, reject) => { rejectPeer = reject; }),
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await new Promise(resolve => setImmediate(resolve));
  voice._nativeScreenSessionId = 'native-session-new2';
  voice._screenStartOperation = 9;
  rejectPeer(new Error('old viewer failed'));

  assert.equal(await pending, false);
  assert.equal(voice._nativeScreenSessionId, 'native-session-new2');
  assert.equal(voice.isScreenSharing, true);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), [{ sessionId: 'native-session-1234' }]);
});

test('native startup rechecks ownership after delayed cleanup', async () => {
  let resolveHelperStop;
  let markHelperStopStarted;
  const helperStopStarted = new Promise(resolve => { markHelperStopStarted = resolve; });
  const api = completeNativeApi({
    addPeer: async () => { throw new Error('viewer failed'); },
    stop: () => {
      markHelperStopStarted();
      return new Promise(resolve => { resolveHelperStop = resolve; });
    },
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
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, 1]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
  });

  const pending = voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3);
  await helperStopStarted;
  voice._nativeScreenSessionId = 'native-session-new2';
  voice._screenStartOperation = 9;
  resolveHelperStop();

  assert.equal(await pending, false);
  assert.equal(voice._nativeScreenSessionId, 'native-session-new2');
  assert.equal(voice.isScreenSharing, true);
});

test('native startup ignores voice bots when attaching viewers', async () => {
  const attached = [];
  const api = completeNativeApi({
    addPeer: async ({ peerId }) => { attached.push(peerId); },
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
    peers: new Map([[7, {}], [8, {}]]),
    _nativeScreenServerVersion: 1,
    _nativeScreenPeerVersions: new Map([[7, null], [8, 1]]),
    _nativeScreenSenderStates: new Map(),
    socket: {
      emit(event, payload, callback) { callback?.({ ok: true }); },
    },
  });

  assert.equal(await voice._tryStartNativeScreenShare(8, 'a1b2c3d4', 3), true);
  assert.deepEqual(attached, [8]);
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
  let renegotiations = 0;
  let removed = 0;
  let stopped = 0;
  const emitted = [];
  const videoTrack = { kind: 'video', readyState: 'live', stop() { stopped++; } };
  const sender = { track: videoTrack };
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
      connection: {
        addTrack() {},
        getSenders: () => [sender],
        removeTrack() { removed++; },
      },
    }]]),
    socket: { emit: (event, payload) => emitted.push({ event, payload }) },
    _applyScreenBitrate() {},
    _renegotiate: () => {
      renegotiations++;
      if (renegotiations === 1) return new Promise(resolve => { resolveRenegotiation = resolve; });
      return Promise.resolve();
    },
    screenSharers: new Set(),
    _nativeScreenAnnouncements: new Map(),
  });

  const pending = voice.shareScreen();
  await new Promise(resolve => setImmediate(resolve));
  voice.inVoice = false;
  voice.currentChannel = null;
  voice._screenStartOperation++;
  resolveRenegotiation();

  assert.equal(await pending, false);
  assert.equal(voice.isScreenSharing, false);
  assert.equal(voice.screenStream, null);
  assert.equal(removed, 1);
  assert.equal(stopped, 1);
  assert.ok(emitted.some(item =>
    item.event === 'screen-share-stopped' && item.payload.code === 'a1b2c3d4'
  ));
});

test('browser sharing rolls back when the server rejects its lifecycle start', async () => {
  let stopped = 0;
  const events = [];
  const videoTrack = { kind: 'video', readyState: 'live', stop() { stopped++; } };
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
    localUserId: 1,
    _voiceSessionGeneration: 3,
    _screenStartOperation: 8,
    _screenStartInFlight: false,
    isScreenSharing: false,
    screenResolution: 1080,
    screenFrameRate: 30,
    _screenBitrates: { 1080: 8_000_000, 0: 8_000_000 },
    rtcConfig: { iceServers: [] },
    peers: new Map(),
    _nativeScreenServerVersion: 1,
    screenSharers: new Set(),
    _nativeScreenAnnouncements: new Map(),
    socket: {
      emit(event, payload, callback) {
        events.push(event);
        callback?.({ ok: event === 'screen-share-stopped', error: 'not-owner' });
      },
    },
  });

  assert.equal(await voice.shareScreen(), false);
  assert.equal(voice.isScreenSharing, false);
  assert.equal(voice.screenStream, null);
  assert.equal(stopped, 1);
  assert.deepEqual(events, ['screen-share-started', 'screen-share-stopped']);
});

test('browser stop retry is cancelled after a newer share starts', async () => {
  let stopEvents = 0;
  const VoiceManager = loadVoiceManager({ window: {} });
  const voice = Object.create(VoiceManager.prototype);
  Object.assign(voice, {
    isScreenSharing: false,
    _nativeScreenServerVersion: 1,
    _screenLifecycleStopTimeoutMs: 10,
    socket: {
      connected: true,
      emit(event) {
        if (event !== 'screen-share-stopped') return;
        stopEvents++;
        if (stopEvents === 1) setTimeout(() => { voice.isScreenSharing = true; }, 0);
      },
    },
  });

  assert.equal(await voice._announceScreenStopped(
    ['a1b2c3d4'],
    null,
    () => !voice.isScreenSharing
  ), false);
  assert.equal(stopEvents, 1);
});
