ALTER TABLE messages ADD COLUMN client_message_id TEXT;

CREATE UNIQUE INDEX messages_client_identity_idx
  ON messages(room_id, sender_type, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
