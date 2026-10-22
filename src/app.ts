
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "./config/database.js";
import { firestore } from "./config/firebase.js";

const app = express();

app.use(express.json());

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
}

interface ChatRow extends RowDataPacket {
  id: number;
  user_a_id: number;
  user_b_id: number;
  created_at: Date;
}

interface MemberRow extends RowDataPacket {
  user_id: number;
}

interface ChatIdRow extends RowDataPacket {
  id: number;
}

interface SendMessageBody {
  senderId: number;
  text: string;
}

interface ReadMessageBody {
  userId: number;
}

interface LastSeenBody {
  userId: number;
  messageId: string;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sendError(
  res: Response,
  status: number,
  message: string,
): void {
  res.status(status).json({ success: false, message });
}

async function isChatMember(
  chatId: number,
  userId: number,
): Promise<boolean> {
  const [rows] = await pool.execute<MemberRow[]>(
    `SELECT user_id
     FROM chat_members
     WHERE chat_id = ? AND user_id = ?
     LIMIT 1`,
    [chatId, userId],
  );

  return rows.length > 0;
}

async function getChat(
  chatId: number,
): Promise<ChatRow | undefined> {
  const [rows] = await pool.execute<ChatRow[]>(
    `SELECT id, user_a_id, user_b_id, created_at
     FROM chats
     WHERE id = ?
     LIMIT 1`,
    [chatId],
  );

  return rows[0];
}

function messageCollection(chatId: number) {
  return firestore
    .collection("chats")
    .doc(String(chatId))
    .collection("messages");
}

function toIsoString(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }

  return null;
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ success: true, message: "Chat backend is running" });
});

// 1. Create or retrieve a one-to-one chat
app.post(
  "/chat/create",
  async (req: Request, res: Response): Promise<void> => {
    const userAId = positiveInteger(req.body?.userAId);
    const userBId = positiveInteger(req.body?.userBId);

    if (userAId === null || userBId === null) {
      sendError(res, 400, "userAId and userBId must be positive integers");
      return;
    }

    if (userAId === userBId) {
      sendError(res, 400, "A user cannot chat with themselves");
      return;
    }

    const firstUserId = Math.min(userAId, userBId);
    const secondUserId = Math.max(userAId, userBId);
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [users] = await connection.execute<UserRow[]>(
        "SELECT id, name, email FROM users WHERE id IN (?, ?)",
        [firstUserId, secondUserId],
      );

      if (users.length !== 2) {
        await connection.rollback();
        sendError(res, 404, "One or both users were not found");
        return;
      }

      await connection.execute<ResultSetHeader>(
        `INSERT INTO chats (user_a_id, user_b_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [firstUserId, secondUserId],
      );

      const [chatRows] = await connection.execute<ChatIdRow[]>(
        `SELECT id FROM chats
         WHERE user_a_id = ? AND user_b_id = ?`,
        [firstUserId, secondUserId],
      );

      const chatId = chatRows[0]?.id;

      if (!chatId) {
        throw new Error("Unable to create or retrieve chat");
      }

      await connection.execute(
        `INSERT IGNORE INTO chat_members (chat_id, user_id)
         VALUES (?, ?), (?, ?)`,
        [chatId, firstUserId, chatId, secondUserId],
      );

      await connection.commit();

      res.status(200).json({
        success: true,
        chatId,
        participants: [firstUserId, secondUserId],
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
);

// 2. Send a message
app.post(
  "/chat/:chatId/message/send",
  async (req: Request, res: Response): Promise<void> => {
    const chatId = positiveInteger(req.params.chatId);
    const body = req.body as SendMessageBody;
    const senderId = positiveInteger(body?.senderId);
    const text = body?.text;

    if (
      chatId === null ||
      senderId === null ||
      !isNonEmptyString(text)
    ) {
      sendError(res, 400, "Valid chatId, senderId and text are required");
      return;
    }

    const chat = await getChat(chatId);

    if (!chat) {
      sendError(res, 404, "Chat not found");
      return;
    }

    if (!(await isChatMember(chatId, senderId))) {
      sendError(res, 403, "Sender is not a member of this chat");
      return;
    }

    const messageRef = messageCollection(chatId).doc();

    await messageRef.set({
      chatId,
      senderId,
      text: text.trim(),
      createdAt: FieldValue.serverTimestamp(),
      editedAt: null,
      deletedAt: null,
    });

    const savedMessage = await messageRef.get();
    const data = savedMessage.data();

    res.status(201).json({
      success: true,
      message: {
        id: messageRef.id,
        chatId,
        senderId,
        text: text.trim(),
        createdAt: toIsoString(data?.createdAt),
      },
    });
  },
);

// 3. Retrieve messages in chronological order
app.get(
  "/chat/:chatId/messages",
  async (req: Request, res: Response): Promise<void> => {
    const chatId = positiveInteger(req.params.chatId);
    const requestedLimit =
      req.query.limit === undefined ? 50 : Number(req.query.limit);

    if (chatId === null) {
      sendError(res, 400, "Invalid chatId");
      return;
    }

    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 100
    ) {
      sendError(res, 400, "limit must be between 1 and 100");
      return;
    }

    const chat = await getChat(chatId);

    if (!chat) {
      sendError(res, 404, "Chat not found");
      return;
    }

    // Optional membership check. Production deployments should require
    // authenticated identity on every chat read.
    if (req.query.userId !== undefined) {
      const userId = positiveInteger(req.query.userId);

      if (userId === null) {
        sendError(res, 400, "Invalid userId");
        return;
      }

      if (!(await isChatMember(chatId, userId))) {
        sendError(res, 403, "User is not a member of this chat");
        return;
      }
    }

    let query = messageCollection(chatId)
      .orderBy("createdAt", "desc")
      .limit(requestedLimit);

    const before = req.query.before;

    if (before !== undefined) {
      if (!isNonEmptyString(before)) {
        sendError(res, 400, "Invalid before message ID");
        return;
      }

      const cursor = await messageCollection(chatId).doc(before).get();

      if (!cursor.exists) {
        sendError(res, 404, "Cursor message not found");
        return;
      }

      query = query.startAfter(cursor);
    }

    const snapshot = await query.get();

    const messages = snapshot.docs
      .map((doc) => {
        const data = doc.data();

        return {
          id: doc.id,
          chatId,
          senderId: data.senderId,
          text: data.text,
          createdAt: toIsoString(data.createdAt),
          editedAt: toIsoString(data.editedAt),
          deletedAt: toIsoString(data.deletedAt),
        };
      })
      .reverse();

    res.json({
      success: true,
      count: messages.length,
      messages,
      nextCursor:
        snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]!.id
          : null,
    });
  },
);

// 4. Mark a message as read
app.post(
  "/chat/:chatId/message/:messageId/read",
  async (req: Request, res: Response): Promise<void> => {
    const chatId = positiveInteger(req.params.chatId);
    const messageId = req.params.messageId;
    const body = req.body as ReadMessageBody;
    const userId = positiveInteger(body?.userId);

    if (
      chatId === null ||
      !isNonEmptyString(messageId) ||
      userId === null
    ) {
      sendError(res, 400, "Valid chatId, messageId and userId are required");
      return;
    }

    if (!(await isChatMember(chatId, userId))) {
      sendError(res, 403, "User is not a member of this chat");
      return;
    }

    const messageRef = messageCollection(chatId).doc(messageId);
    const message = await messageRef.get();

    if (!message.exists) {
      sendError(res, 404, "Message not found");
      return;
    }

    if (message.get("senderId") === userId) {
      sendError(res, 400, "A user cannot mark their own message as read");
      return;
    }

    await messageRef
      .collection("readReceipts")
      .doc(String(userId))
      .set(
        {
          userId,
          readAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    res.json({
      success: true,
      message: "Message marked as read",
      chatId,
      messageId,
      userId,
    });
  },
);

// 5. Update last-seen message
app.post(
  "/chat/:chatId/lastseen",
  async (req: Request, res: Response): Promise<void> => {
    const chatId = positiveInteger(req.params.chatId);
    const body = req.body as LastSeenBody;
    const userId = positiveInteger(body?.userId);
    const messageId = body?.messageId;

    if (
      chatId === null ||
      userId === null ||
      !isNonEmptyString(messageId)
    ) {
      sendError(res, 400, "Valid chatId, userId and messageId are required");
      return;
    }

    if (!(await isChatMember(chatId, userId))) {
      sendError(res, 403, "User is not a member of this chat");
      return;
    }

    const message = await messageCollection(chatId)
      .doc(messageId)
      .get();

    if (!message.exists) {
      sendError(res, 404, "Message not found");
      return;
    }

    const lastSeenRef = firestore
      .collection("chats")
      .doc(String(chatId))
      .collection("lastSeen")
      .doc(String(userId));

    await lastSeenRef.set(
      {
        userId,
        messageId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({
      success: true,
      message: "Last-seen position updated",
      chatId,
      userId,
      messageId,
    });
  },
);

// 6. Get all chats for a user
app.get(
  "/user/:userId/chats",
  async (req: Request, res: Response): Promise<void> => {
    const userId = positiveInteger(req.params.userId);

    if (userId === null) {
      sendError(res, 400, "Invalid userId");
      return;
    }

    const [users] = await pool.execute<UserRow[]>(
      "SELECT id, name, email FROM users WHERE id = ? LIMIT 1",
      [userId],
    );

    if (users.length === 0) {
      sendError(res, 404, "User not found");
      return;
    }

    const [chats] = await pool.execute<ChatRow[]>(
      `SELECT c.id, c.user_a_id, c.user_b_id, c.created_at
       FROM chats c
       INNER JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = ?
       ORDER BY c.created_at DESC`,
      [userId],
    );

    const result = await Promise.all(
      chats.map(async (chat) => {
        const otherUserId =
          chat.user_a_id === userId ? chat.user_b_id : chat.user_a_id;

        const [otherUsers] = await pool.execute<UserRow[]>(
          "SELECT id, name, email FROM users WHERE id = ? LIMIT 1",
          [otherUserId],
        );

        const lastMessageSnapshot = await messageCollection(chat.id)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();

        const lastMessageDoc = lastMessageSnapshot.docs[0];
        const lastMessageData = lastMessageDoc?.data();

        const lastSeenSnapshot = await firestore
          .collection("chats")
          .doc(String(chat.id))
          .collection("lastSeen")
          .doc(String(userId))
          .get();

        const lastSeenData = lastSeenSnapshot.data();

        return {
          chatId: chat.id,
          createdAt: new Date(chat.created_at).toISOString(),
          otherUser: otherUsers[0]
            ? {
                id: otherUsers[0].id,
                name: otherUsers[0].name,
                email: otherUsers[0].email,
              }
            : null,
          lastMessage: lastMessageDoc
            ? {
                id: lastMessageDoc.id,
                senderId: lastMessageData?.senderId,
                text: lastMessageData?.text,
                createdAt: toIsoString(lastMessageData?.createdAt),
              }
            : null,
          lastSeen: lastSeenData
            ? {
                messageId: lastSeenData.messageId,
                updatedAt: toIsoString(lastSeenData.updatedAt),
              }
            : null,
        };
      }),
    );

    res.json({
      success: true,
      count: result.length,
      chats: result,
    });
  },
);

// Central error handler
app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    console.error("API error:", error);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  },
);

export default app;
