# Chat Backend — Node.js, TypeScript, MySQL & Firebase

A REST API backend for one-to-one chat conversations, built with Node.js, Express, TypeScript, MySQL, and Firebase Firestore.

## Features

- Create or retrieve one-to-one chats.
- Store users, conversations, and chat membership in MySQL.
- Store messages and read receipts in Firebase Firestore.
- Retrieve messages in chronological order with pagination.
- Track a user's last-seen message.
- Retrieve a user's conversations with the latest message.
- Validate request parameters and check chat membership on write operations.

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript (strict mode)
- **API:** Express.js
- **Relational database:** MySQL
- **Message storage:** Firebase Firestore
- **Firebase integration:** Firebase Admin SDK

## Project Structure

```text
chat-backend/
├── src/
│   ├── config/
│   │   ├── database.ts
│   │   └── firebase.ts
│   ├── app.ts
│   └── server.ts
├── .env                  # Local configuration; not committed
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Prerequisites

- Node.js and npm
- MySQL Server
- A Firebase project with Firestore enabled
- A Firebase service-account JSON key for local development

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/mraduljain/chat-backend.git
cd chat-backend
npm install
```

### 2. Configure MySQL

Create the database:

```sql
CREATE DATABASE chat_backend;
USE chat_backend;
```

Create the tables below:

```sql
CREATE TABLE users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chats (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_a_id BIGINT UNSIGNED NOT NULL,
    user_b_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_chat_pair UNIQUE (user_a_id, user_b_id),
    CONSTRAINT fk_chat_user_a FOREIGN KEY (user_a_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_user_b FOREIGN KEY (user_b_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_distinct_users CHECK (user_a_id < user_b_id)
);

CREATE TABLE chat_members (
    chat_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    last_seen_message_id VARCHAR(128) NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_members_user ON chat_members(user_id);
```

Add two test users:

```sql
INSERT INTO users (name, email)
VALUES
    ('Mradul', 'mradul@example.com'),
    ('Test User', 'testuser@example.com');
```

If users already exist, do not insert them again with the same email.

### 3. Configure Firebase

1. Create a Firebase project and enable Cloud Firestore.
2. Generate a service-account private key from Firebase Project Settings → Service accounts.
3. Store the downloaded JSON key securely outside the repository.
4. Configure the credentials path in your environment.

**Never commit the service-account JSON file or expose its private key.**

### 4. Create the `.env` file

Create `.env` in the project root:

```dotenv
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=chat_backend
GOOGLE_APPLICATION_CREDENTIALS=C:/secure/firebase-service-account.json
```

Replace the example values with your actual local configuration. Ensure the Firebase credentials path points to your downloaded key.

### 5. Build and run

```bash
npm run build
npm run dev
```

The API runs at `http://localhost:3000`.

Health check:

```http
GET /health
```

## API Reference

### 1. Create a chat

```http
POST /chat/create
Content-Type: application/json
```

Request:

```json
{
  "userAId": 1,
  "userBId": 2
}
```

Creates a conversation or returns the existing conversation for the same user pair.

### 2. Send a message

```http
POST /chat/:chatId/message/send
Content-Type: application/json
```

Request:

```json
{
  "senderId": 1,
  "text": "Hello!"
}
```

Creates a message document in Firestore and returns its message ID.

### 3. Get messages

```http
GET /chat/:chatId/messages?limit=50&userId=2
```

Supports a configurable limit from 1 to 100 and an optional `before` cursor for pagination.

### 4. Mark a message as read

```http
POST /chat/:chatId/message/:messageId/read
Content-Type: application/json
```

Request:

```json
{
  "userId": 2
}
```

Stores a read receipt for the specified user and message.

### 5. Update last seen

```http
POST /chat/:chatId/lastseen
Content-Type: application/json
```

Request:

```json
{
  "userId": 2,
  "messageId": "MESSAGE_ID"
}
```

Records the user's latest seen message and update timestamp in Firestore.

### 6. Get a user's chats

```http
GET /user/:userId/chats
```

Returns the user's conversations, other participant, latest message, and available last-seen information.

## Storage Design

| Data | Storage |
|---|---|
| User profiles | MySQL |
| One-to-one conversations | MySQL |
| Chat membership | MySQL |
| Messages | Firebase Firestore |
| Message read receipts | Firebase Firestore |
| Last-seen position | Firebase Firestore |

## Error Handling

The API returns JSON responses and appropriate HTTP status codes for common validation errors, missing resources, and membership checks. Unexpected server errors are logged on the server and returned as generic internal-server-error responses.

## Security Considerations

This repository is an assessment implementation, not a production-ready messaging service.

Before production deployment, add authenticated identity verification and authorization to every endpoint, validate access to chat history, configure request limits and logging, and protect credentials with a managed secret store. User IDs supplied in request bodies or query parameters are not proof of identity.

## License

This project was created as a technical assessment.