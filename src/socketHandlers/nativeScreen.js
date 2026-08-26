'use strict';

const { isString, isInt } = require('./helpers');

const MAX_SDP_SIZE = 16384;
const MAX_ICE_SIZE = 2048;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NEGOTIATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_OFFERS_PER_TARGET_WINDOW = 8;
const OFFER_WINDOW_MS = 10000;

function registerNativeScreenSignaling(socket, ctx) {
  const { io, voiceUsers, activeScreenSharers, activeScreenSessions } = ctx;
  const offerWindows = ctx.nativeScreenOfferWindows || new Map();

  function allowOffer(code, targetUserId) {
    const now = Date.now();
    const key = `${socket.user.id}:${targetUserId}:${code}`;
    const recent = (offerWindows.get(key) || [])
      .filter(timestamp => now - timestamp < OFFER_WINDOW_MS);
    if (recent.length >= MAX_OFFERS_PER_TARGET_WINDOW) {
      offerWindows.set(key, recent);
      return false;
    }
    recent.push(now);
    offerWindows.set(key, recent);
    return true;
  }

  function relay(eventName, field, maxSize, relation, allowNull = false) {
    socket.on(eventName, data => {
      if (!data || typeof data !== 'object') return;
      if (!isString(data.code, 8, 8) || !isInt(data.targetUserId)) return;
      if (!SESSION_ID_PATTERN.test(String(data.sessionId || ''))) return;
      if (!NEGOTIATION_ID_PATTERN.test(String(data.negotiationId || ''))) return;

      const room = voiceUsers.get(data.code);
      const sender = room?.get(socket.user.id);
      const target = room?.get(data.targetUserId);
      if (!sender || sender.socketId !== socket.id || !target || target.id === socket.user.id) return;

      const sharers = activeScreenSharers.get(data.code);
      const senderIsSharer = sharers?.has(socket.user.id) === true;
      const targetIsSharer = sharers?.has(data.targetUserId) === true;
      if (relation === 'sender' && !senderIsSharer) return;
      if (relation === 'target' && !targetIsSharer) return;
      if (relation === 'either' && !senderIsSharer && !targetIsSharer) return;

      const sessions = activeScreenSessions.get(data.code);
      const matchesSession = userId => {
        const session = sessions?.get(userId);
        return session?.transport === 'native' && session.sessionId === data.sessionId;
      };
      if (relation === 'sender' && !matchesSession(socket.user.id)) return;
      if (relation === 'target' && !matchesSession(data.targetUserId)) return;
      if (relation === 'either' &&
          !matchesSession(socket.user.id) && !matchesSession(data.targetUserId)) return;
      if (eventName === 'native-screen-offer' && !allowOffer(data.code, data.targetUserId)) return;

      const signal = data[field];
      if (!allowNull && (!signal || typeof signal !== 'object')) return;
      if (signal && (typeof signal !== 'object' || JSON.stringify(signal).length > maxSize)) return;

      io.to(target.socketId).emit(eventName, {
        from: { id: socket.user.id, username: socket.user.displayName },
        channelCode: data.code,
        sessionId: data.sessionId,
        negotiationId: data.negotiationId,
        [field]: signal || null,
      });
    });
  }

  relay('native-screen-offer', 'offer', MAX_SDP_SIZE, 'sender');
  relay('native-screen-answer', 'answer', MAX_SDP_SIZE, 'target');
  relay('native-screen-ice-candidate', 'candidate', MAX_ICE_SIZE, 'either', true);
}

module.exports = {
  MAX_SDP_SIZE,
  MAX_ICE_SIZE,
  MAX_OFFERS_PER_TARGET_WINDOW,
  SESSION_ID_PATTERN,
  NEGOTIATION_ID_PATTERN,
  registerNativeScreenSignaling,
};
