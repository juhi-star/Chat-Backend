import { pool } from '../db';
import { HttpError } from '../errors';
import type { ChatSummary } from '../types';

interface ChatRow {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  created_by: string | null;
  created_at: Date;
}

type ChatRowWithMembers = ChatRow & { member_ids: string[] };

function mapChat(r: ChatRowWithMembers): ChatSummary {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    createdBy: r.created_by,
    memberIds: r.member_ids,
    createdAt: r.created_at.toISOString(),
  };
}

async function assertUsersExist(userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  const users = await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [unique]);
  if (users.rowCount !== unique.length) throw new HttpError(404, 'One or more users not found');
}

async function getChatRow(chatId: string): Promise<ChatRow> {
  const { rows } = await pool.query<ChatRow>(
    'SELECT id, type, name, created_by, created_at FROM chats WHERE id = $1',
    [chatId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Chat not found');
  return row;
}

export async function createUser(name: string): Promise<{ id: string; name: string }> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    'INSERT INTO users (name) VALUES ($1) RETURNING id, name',
    [name],
  );
  return rows[0]!;
}

export async function createOrGetDirectChat(userAId: string, userBId: string): Promise<string> {
  const userA = userAId.toLowerCase();
  const userB = userBId.toLowerCase();
  if (userA === userB) throw new HttpError(400, 'Cannot create a chat with yourself');

  await assertUsersExist([userA, userB]);

  const directKey = [userA, userB].sort().join(':');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key) VALUES ('direct', $1)
       ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
      [directKey],
    );
    let chatId = inserted.rows[0]?.id;
    if (chatId) {
      await client.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [
        chatId,
        userA,
        userB,
      ]);
    } else {
      // Lost the race or chat already existed
      const existing = await client.query<{ id: string }>('SELECT id FROM chats WHERE direct_key = $1', [directKey]);
      chatId = existing.rows[0]!.id;
    }
    await client.query('COMMIT');
    return chatId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function createGroupChat(
  creatorId: string,
  name: string,
  memberIds: string[],
): Promise<ChatSummary> {
  const creator = creatorId.toLowerCase();
  const allMembers = [...new Set([creator, ...memberIds.map((m) => m.toLowerCase())])];
  if (allMembers.length < 2) throw new HttpError(400, 'A group chat needs at least two members');
  await assertUsersExist(allMembers);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2)
       RETURNING id, created_at`,
      [name, creator],
    );
    const chat = inserted.rows[0]!;
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id)
       SELECT $1::uuid, unnest($2::uuid[])`,
      [chat.id, allMembers],
    );
    await client.query('COMMIT');
    return {
      id: chat.id,
      type: 'group',
      name,
      createdBy: creator,
      memberIds: allMembers,
      createdAt: chat.created_at.toISOString(),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getChat(chatId: string): Promise<ChatSummary> {
  const { rows } = await pool.query<ChatRowWithMembers>(
    `SELECT c.id, c.type, c.name, c.created_by, c.created_at,
            array_agg(m.user_id::text ORDER BY m.joined_at, m.user_id) AS member_ids
       FROM chats c
       JOIN chat_members m ON m.chat_id = c.id
      WHERE c.id = $1
      GROUP BY c.id`,
    [chatId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Chat not found');
  return mapChat(row);
}

export async function renameGroupChat(chatId: string, requesterId: string, name: string): Promise<ChatSummary> {
  const chat = await getChatRow(chatId);
  if (chat.type !== 'group') throw new HttpError(400, 'Only group chats can be renamed');
  if (chat.created_by !== requesterId.toLowerCase()) {
    throw new HttpError(403, 'Only the group creator can rename the group');
  }
  await pool.query('UPDATE chats SET name = $1 WHERE id = $2', [name, chatId]);
  return getChat(chatId);
}

export async function addGroupMember(
  chatId: string,
  requesterId: string,
  userId: string,
): Promise<ChatSummary> {
  const chat = await getChatRow(chatId);
  if (chat.type !== 'group') throw new HttpError(400, 'Only group chats can have members added');
  await assertChatMember(chatId, requesterId);
  const memberId = userId.toLowerCase();
  await assertUsersExist([memberId]);
  await pool.query(
    `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)
     ON CONFLICT (chat_id, user_id) DO NOTHING`,
    [chatId, memberId],
  );
  return getChat(chatId);
}

export async function removeGroupMember(
  chatId: string,
  requesterId: string,
  userId: string,
): Promise<ChatSummary> {
  const chat = await getChatRow(chatId);
  if (chat.type !== 'group') throw new HttpError(400, 'Only group chats can have members removed');
  const requester = requesterId.toLowerCase();
  const memberId = userId.toLowerCase();
  await assertChatMember(chatId, requester);
  if (requester !== memberId && chat.created_by !== requester) {
    throw new HttpError(403, 'Only the group creator can remove other members');
  }
  if (memberId === chat.created_by) throw new HttpError(400, 'The group creator cannot be removed');

  const deleted = await pool.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, memberId]);
  if (deleted.rowCount === 0) throw new HttpError(404, 'User is not a member of this chat');
  return getChat(chatId);
}

export async function assertChatMember(chatId: string, userId: string): Promise<void> {
  const chat = await pool.query('SELECT 1 FROM chats WHERE id = $1', [chatId]);
  if (chat.rowCount === 0) throw new HttpError(404, 'Chat not found');
  const m = await pool.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  if (m.rowCount === 0) throw new HttpError(403, 'User is not a member of this chat');
}

export async function assertChatExists(chatId: string): Promise<void> {
  const chat = await pool.query('SELECT 1 FROM chats WHERE id = $1', [chatId]);
  if (chat.rowCount === 0) throw new HttpError(404, 'Chat not found');
}

export async function listUserChats(userId: string): Promise<ChatSummary[]> {
  const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (user.rowCount === 0) throw new HttpError(404, 'User not found');

  const { rows } = await pool.query<ChatRowWithMembers>(
    `SELECT c.id, c.type, c.name, c.created_by, c.created_at,
            array_agg(m2.user_id::text ORDER BY m2.joined_at, m2.user_id) AS member_ids
       FROM chat_members m
       JOIN chats c ON c.id = m.chat_id
       JOIN chat_members m2 ON m2.chat_id = c.id
      WHERE m.user_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows.map(mapChat);
}
