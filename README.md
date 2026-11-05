# Chat Backend (Node + TS, PostgreSQL, Firestore)

## Setup
```bash
npm install
cp .env.example .env
createdb chat && npm run migrate        # needs PostgreSQL 13+
firebase emulators:start --only firestore   # or use real credentials
npm run dev
```

## Data model
- **PostgreSQL**: `users`, `chats`, `chat_members`. `chats.direct_key` (`minId:maxId`, UNIQUE) makes
  create-or-get idempotent and race-safe. Group chats use `chats.type='group'`, `name`, `created_by`.
- **Firestore**
  - `chats/{chatId}/messages/{messageId}` → `senderId, text, createdAt (server timestamp), editedAt, deleted, readBy{userId: ts}`
  - `chats/{chatId}/members/{userId}` → `lastSeenMessageId, lastSeenAt`

## Endpoints
| Method | Path | Body |
|---|---|---|
| POST | /users | `{name}` (test helper) |
| POST | /chat/create | `{userAId, userBId}` → `{chatId}` |
| POST | /chat/:chatId/message/send | `{senderId, text}` |
| GET | /chat/:chatId/messages?limit=50&before=<messageId> | |
| POST | /chat/:chatId/message/:messageId/read | `{userId}` |
| POST | /chat/:chatId/lastseen | `{userId, messageId}` |
| GET | /user/:userId/chats | |

### Bonus
| Method | Path | Body |
|---|---|---|
| POST | /chat/group/create | `{creatorId, name, memberIds: string[]}` |
| GET | /chat/:chatId | |
| PATCH | /chat/:chatId | `{requesterId, name}` (creator only) |
| POST | /chat/:chatId/members | `{requesterId, userId}` |
| DELETE | /chat/:chatId/members/:userId | `{requesterId}` |
| PATCH | /chat/:chatId/message/:messageId | `{senderId, text}` (sender only) |
| DELETE | /chat/:chatId/message/:messageId | `{senderId}` (sender only, soft delete) |

## Notes
- Only chat members can send / read / update last seen; membership is checked against PostgreSQL.
- Messages ordered by server `createdAt`, tie-broken by document id; `GET` returns the latest N in ascending order.
- Last seen only moves forward; read receipts are idempotent (first read time is kept).
- No authentication: `senderId`/`userId` come from the body per the spec. In production derive them from a verified token.
- Firestore needs a composite index only if you add filters; the `createdAt`+`__name__` order is covered automatically.
