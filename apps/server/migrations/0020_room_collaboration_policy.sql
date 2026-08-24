ALTER TABLE rooms ADD COLUMN collaboration_policy_json TEXT NOT NULL
  DEFAULT '{"allowDiscussion":true,"allowAll":true,"allowAgentMentions":true,"maxAgentMentionDepth":4}'
  CHECK (json_valid(collaboration_policy_json));
