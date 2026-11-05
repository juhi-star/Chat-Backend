export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  createdAt: string; // ISO-8601
  editedAt: string | null;
  deleted: boolean;
  readBy: Record<string, string>; // userId -> ISO-8601 read time
}

export interface ChatSummary {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  createdBy: string | null;
  memberIds: string[];
  createdAt: string;
}

export interface LastSeen {
  userId: string;
  lastSeenMessageId: string;
  lastSeenAt: string;
}
