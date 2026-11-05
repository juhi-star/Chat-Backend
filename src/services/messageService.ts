import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData, DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { firestore } from '../firebase';
import { HttpError } from '../errors';
import type { LastSeen, Message } from '../types';
import { assertChatExists, assertChatMember } from './chatService';

// chats/{chatId}/messages/{messageId}  -> message + readBy map (read receipts)
// chats/{chatId}/members/{userId}      -> lastSeenMessageId / lastSeenAt
const messagesCol = (chatId: string) => firestore.collection('chats').doc(chatId).collection('messages');
const memberDoc = (chatId: string, userId: string) =>
  firestore.collection('chats').doc(chatId).collection('members').doc(userId);

const iso = (t: unknown): string | null => (t instanceof Timestamp ? t.toDate().toISOString() : null);

function toMessage(chatId: string, snap: DocumentSnapshot<DocumentData>): Message {
  const d = snap.data();
  if (!d) throw new HttpError(404, 'Message not found');
  const readBy: Record<string, string> = {};
  for (const [uid, ts] of Object.entries((d.readBy ?? {}) as Record<string, unknown>)) {
    const v = iso(ts);
    if (v) readBy[uid] = v;
  }
  return {
    id: snap.id,
    chatId,
    senderId: d.senderId as string,
    text: d.deleted ? '' : (d.text as string),
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    editedAt: iso(d.editedAt),
    deleted: Boolean(d.deleted),
    readBy,
  };
}

async function requireMessage(chatId: string, messageId: string): Promise<DocumentReference<DocumentData>> {
  const ref = messagesCol(chatId).doc(messageId);
  if (!(await ref.get()).exists) throw new HttpError(404, 'Message not found');
  return ref;
}

export async function sendMessage(chatId: string, senderId: string, text: string): Promise<Message> {
  await assertChatMember(chatId, senderId);
  const ref = messagesCol(chatId).doc();
  await ref.set({
    senderId,
    text,
    createdAt: FieldValue.serverTimestamp(), // server-side ordering, immune to client clock skew
    editedAt: null,
    deleted: false,
    readBy: {},
  });
  return toMessage(chatId, await ref.get());
}

/** Returns the latest `limit` messages in ascending order. `before` = message id cursor for older pages. */
export async function getMessages(chatId: string, limit: number, before?: string): Promise<Message[]> {
  await assertChatExists(chatId);
  let q = messagesCol(chatId)
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc') // deterministic tie-break
    .limit(limit);
  if (before) {
    const cursor = await messagesCol(chatId).doc(before).get();
    if (!cursor.exists) throw new HttpError(400, 'Invalid "before" cursor');
    q = q.startAfter(cursor);
  }
  const snap = await q.get();
  return snap.docs.map((d) => toMessage(chatId, d)).reverse();
}

export async function markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
  await assertChatMember(chatId, userId);
  const ref = messagesCol(chatId).doc(messageId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Message not found');
    if (snap.get(new FieldPath('readBy', userId)) != null) return; // idempotent: keep first read time
    tx.update(ref, new FieldPath('readBy', userId), FieldValue.serverTimestamp());
  });
  return toMessage(chatId, await ref.get());
}

/** Moves the user's last-seen pointer forward only (never backwards). */
export async function updateLastSeen(chatId: string, userId: string, messageId: string): Promise<LastSeen> {
  await assertChatMember(chatId, userId);
  const msgRef = messagesCol(chatId).doc(messageId);
  const mRef = memberDoc(chatId, userId);

  await firestore.runTransaction(async (tx) => {
    const [msg, member] = await Promise.all([tx.get(msgRef), tx.get(mRef)]);
    if (!msg.exists) throw new HttpError(404, 'Message not found');

    const currentId = member.get('lastSeenMessageId') as string | undefined;
    if (currentId && currentId !== messageId) {
      const current = await tx.get(messagesCol(chatId).doc(currentId));
      const cur = current.get('createdAt');
      const next = msg.get('createdAt');
      // Only refuse to move backwards. Equal timestamps are allowed to move so that
      // messages written in the same server-timestamp tick do not block the pointer.
      if (cur instanceof Timestamp && next instanceof Timestamp && cur.valueOf() > next.valueOf()) return;
    }
    tx.set(mRef, { lastSeenMessageId: messageId, lastSeenAt: FieldValue.serverTimestamp() }, { merge: true });
  });

  const saved = await mRef.get();
  return {
    userId,
    lastSeenMessageId: saved.get('lastSeenMessageId') as string,
    lastSeenAt: iso(saved.get('lastSeenAt')) ?? new Date().toISOString(),
  };
}

// ---- Bonus: edit / delete -------------------------------------------------

export async function editMessage(chatId: string, messageId: string, senderId: string, text: string): Promise<Message> {
  await assertChatMember(chatId, senderId);
  const ref = await requireMessage(chatId, messageId);
  const snap = await ref.get();
  if (snap.get('senderId') !== senderId) throw new HttpError(403, 'Only the sender can edit a message');
  if (snap.get('deleted')) throw new HttpError(409, 'Message was deleted');
  await ref.update({ text, editedAt: FieldValue.serverTimestamp() });
  return toMessage(chatId, await ref.get());
}

export async function deleteMessage(chatId: string, messageId: string, senderId: string): Promise<void> {
  await assertChatMember(chatId, senderId);
  const ref = await requireMessage(chatId, messageId);
  if ((await ref.get()).get('senderId') !== senderId) throw new HttpError(403, 'Only the sender can delete a message');
  await ref.update({ deleted: true, text: '', editedAt: FieldValue.serverTimestamp() }); // soft delete
}
