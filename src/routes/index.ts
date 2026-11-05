import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors';
import * as chats from '../services/chatService';
import * as messages from '../services/messageService';

const id = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase()); // canonical form: direct-chat keys and comparisons are case-sensitive
const text = z.string().trim().min(1).max(4000);
const chatName = z.string().trim().min(1).max(100);
// Firestore document ids may be arbitrary strings, but must not contain "/".
const msgId = z.string().min(1).max(1500).regex(/^[^/]+$/, 'Invalid message id');

export const router = Router();

// Helper for quick testing (not in the spec)
router.post('/users', asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
  res.status(201).json(await chats.createUser(name));
}));

// 1. Create or get direct chat
router.post('/chat/create', asyncHandler(async (req, res) => {
  const { userAId, userBId } = z.object({ userAId: id, userBId: id }).parse(req.body);
  res.json({ chatId: await chats.createOrGetDirectChat(userAId, userBId) });
}));

// Bonus: group chat creation & management
router.post('/chat/group/create', asyncHandler(async (req, res) => {
  const { creatorId, name, memberIds } = z
    .object({ creatorId: id, name: chatName, memberIds: z.array(id).min(1).max(500) })
    .parse(req.body);
  res.status(201).json(await chats.createGroupChat(creatorId, name, memberIds));
}));

router.get('/chat/:chatId', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  res.json(await chats.getChat(chatId));
}));

router.patch('/chat/:chatId', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  const { requesterId, name } = z.object({ requesterId: id, name: chatName }).parse(req.body);
  res.json(await chats.renameGroupChat(chatId, requesterId, name));
}));

router.post('/chat/:chatId/members', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  const { requesterId, userId } = z.object({ requesterId: id, userId: id }).parse(req.body);
  res.json(await chats.addGroupMember(chatId, requesterId, userId));
}));

router.delete('/chat/:chatId/members/:userId', asyncHandler(async (req, res) => {
  const { chatId, userId } = z.object({ chatId: id, userId: id }).parse(req.params);
  const { requesterId } = z.object({ requesterId: id }).parse(req.body);
  res.json(await chats.removeGroupMember(chatId, requesterId, userId));
}));

// 2. Send message
router.post('/chat/:chatId/message/send', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  const { senderId, text: body } = z.object({ senderId: id, text }).parse(req.body);
  res.status(201).json(await messages.sendMessage(chatId, senderId, body));
}));

// 3. Get messages
router.get('/chat/:chatId/messages', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  const { limit, before } = z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: msgId.optional() })
    .parse(req.query);
  res.json({ messages: await messages.getMessages(chatId, limit, before) });
}));

// 4. Mark message read
router.post('/chat/:chatId/message/:messageId/read', asyncHandler(async (req, res) => {
  const { chatId, messageId } = z.object({ chatId: id, messageId: msgId }).parse(req.params);
  const { userId } = z.object({ userId: id }).parse(req.body);
  res.json(await messages.markRead(chatId, messageId, userId));
}));

// 5. Update last seen message
router.post('/chat/:chatId/lastseen', asyncHandler(async (req, res) => {
  const { chatId } = z.object({ chatId: id }).parse(req.params);
  const { userId, messageId } = z.object({ userId: id, messageId: msgId }).parse(req.body);
  res.json(await messages.updateLastSeen(chatId, userId, messageId));
}));

// 6. List user chats
router.get('/user/:userId/chats', asyncHandler(async (req, res) => {
  const { userId } = z.object({ userId: id }).parse(req.params);
  res.json({ chats: await chats.listUserChats(userId) });
}));

// Bonus: edit / delete
router.patch('/chat/:chatId/message/:messageId', asyncHandler(async (req, res) => {
  const { chatId, messageId } = z.object({ chatId: id, messageId: msgId }).parse(req.params);
  const { senderId, text: body } = z.object({ senderId: id, text }).parse(req.body);
  res.json(await messages.editMessage(chatId, messageId, senderId, body));
}));

router.delete('/chat/:chatId/message/:messageId', asyncHandler(async (req, res) => {
  const { chatId, messageId } = z.object({ chatId: id, messageId: msgId }).parse(req.params);
  const { senderId } = z.object({ senderId: id }).parse(req.body);
  await messages.deleteMessage(chatId, messageId, senderId);
  res.status(204).end();
}));
