-- Scheduler deliveries created before the wire projection normalized the
-- internal execution-scheduler authority key cannot pass the Bridge decoder.
-- Only still-pending payloads are disposable: deleting them lets the normal
-- delivery service rebuild the exact Run request with a schema-valid senderId.
DELETE FROM run_deliveries
WHERE state = 'pending'
  AND (
    EXISTS (
      SELECT 1
      FROM json_each(payload_json, '$.contextMessages') context_message
      WHERE json_extract(context_message.value, '$.senderId') =
        'execution-scheduler'
    ) OR EXISTS (
      SELECT 1
      FROM json_each(
        payload_json,
        '$.roomContextBundle.rawTail.messages'
      ) context_message
      WHERE json_extract(context_message.value, '$.senderId') =
        'execution-scheduler'
    )
  );
