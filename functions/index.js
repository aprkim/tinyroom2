// TinyRoom — LiveKit webhook receiver.
//
// LiveKit Cloud POSTs room/participant lifecycle events here. Each event is
// signature-verified with the project's API key/secret, then written to
// Firestore so admin.html can show minutes used against the monthly cap.
//
//   tinyroomSessions/{participantSid}  one doc per person per visit
//   tinyroomRooms/{roomSid}            one doc per room lifetime
//
// Deploy:  firebase deploy --only functions:tinyroom
// Secrets: firebase functions:secrets:set LIVEKIT_API_KEY / LIVEKIT_API_SECRET

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { WebhookReceiver } = require('livekit-server-sdk');

admin.initializeApp();
const db = admin.firestore();

const LIVEKIT_API_KEY = defineSecret('LIVEKIT_API_KEY');
const LIVEKIT_API_SECRET = defineSecret('LIVEKIT_API_SECRET');

const ROOM_PREFIX = 'tinyroom2-';   // must match ROOM_PREFIX in index.html

// LiveKit timestamps are seconds (sometimes BigInt/strings); event.createdAt too.
function tsFromSeconds(s) {
  const n = Number(s || 0);
  return n > 0 ? admin.firestore.Timestamp.fromMillis(n * 1000) : admin.firestore.Timestamp.now();
}

exports.livekitWebhook = onRequest(
  { region: 'us-east1', secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET], memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('POST only'); return; }

    let event;
    try {
      const receiver = new WebhookReceiver(LIVEKIT_API_KEY.value(), LIVEKIT_API_SECRET.value());
      const body = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      event = await receiver.receive(body, req.get('Authorization'));
    } catch (e) {
      console.warn('Rejected webhook (bad signature or body):', e && e.message);
      res.status(401).send('invalid signature');
      return;
    }

    try {
      await handleEvent(event);
      res.status(200).send('ok');
    } catch (e) {
      console.error('Webhook handling failed:', e);
      res.status(500).send('error');   // LiveKit retries on 5xx
    }
  }
);

async function handleEvent(event) {
  const room = event.room || {};
  const participant = event.participant || {};
  const at = tsFromSeconds(event.createdAt);
  const roomName = room.name || '';
  const code = roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : roomName;
  const roomRef = room.sid ? db.collection('tinyroomRooms').doc(room.sid) : null;

  switch (event.event) {
    case 'room_started':
      if (roomRef) await roomRef.set({ name: roomName, code, startedAt: at, endedAt: null }, { merge: true });
      break;

    case 'room_finished':
      if (roomRef) await roomRef.set({ name: roomName, code, endedAt: at }, { merge: true });
      // Close any sessions LiveKit never sent a participant_left for (crashes, retries).
      if (room.sid) {
        const open = await db.collection('tinyroomSessions').where('roomSid', '==', room.sid).where('leftAt', '==', null).get();
        const batch = db.batch();
        open.forEach(doc => {
          const joined = doc.get('joinedAt');
          const seconds = joined ? Math.max(0, Math.round((at.toMillis() - joined.toMillis()) / 1000)) : 0;
          batch.set(doc.ref, { leftAt: at, seconds, closedBy: 'room_finished' }, { merge: true });
        });
        await batch.commit();
      }
      break;

    case 'participant_joined':
      if (!participant.sid) break;
      await db.collection('tinyroomSessions').doc(participant.sid).set({
        roomSid: room.sid || null,
        room: roomName,
        code,
        identity: participant.identity || '',
        name: participant.name || participant.identity || '',
        joinedAt: tsFromSeconds(participant.joinedAt || event.createdAt),
        leftAt: null,
        seconds: null,
      }, { merge: true });
      if (roomRef) await roomRef.set({ name: roomName, code, startedAt: at }, { merge: true });
      break;

    case 'participant_left': {
      if (!participant.sid) break;
      const ref = db.collection('tinyroomSessions').doc(participant.sid);
      const snap = await ref.get();
      const joined = snap.exists && snap.get('joinedAt')
        ? snap.get('joinedAt')
        : tsFromSeconds(participant.joinedAt || event.createdAt);
      const seconds = Math.max(0, Math.round((at.toMillis() - joined.toMillis()) / 1000));
      await ref.set({
        roomSid: room.sid || null,
        room: roomName,
        code,
        identity: participant.identity || '',
        name: participant.name || participant.identity || '',
        joinedAt: joined,
        leftAt: at,
        seconds,
      }, { merge: true });
      break;
    }

    default:
      // track_published etc. — not needed for usage accounting
      break;
  }
}
