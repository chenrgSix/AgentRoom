-- A carried accepted-result adoption keeps the original ResultReview as its
-- gate proof while the carried EvidenceAdoption remains the revision-local
-- consumption authority. Keep those two identities separate for input readers.
DROP VIEW execution_all_adopted_node_materializations;

CREATE VIEW execution_all_adopted_node_materializations AS
SELECT materialization.plan_id, materialization.plan_revision,
  materialization.node_key, materialization.gate,
  materialization.dispatch_generation, materialization.source_run_id,
  materialization.source_result_id, materialization.source_result_version,
  materialization.gate_operation_id, materialization.materialization_digest,
  materialization.candidate_commit, materialization.candidate_tree,
  materialization.checkpoint_id, materialization.artifact_pins_json,
  materialization.adoption_id, materialization.adoption_digest,
  materialization.source_evidence_id, materialization.source_digest,
  node.task_id AS source_task_id, node.definition_revision,
  node.criteria_revision
FROM execution_adopted_node_materializations materialization
JOIN execution_plan_nodes node ON node.plan_id = materialization.plan_id
  AND node.revision = materialization.plan_revision
  AND node.node_key = materialization.node_key
UNION ALL
SELECT adoption.plan_id, adoption.plan_revision, adoption.node_key,
  adoption.gate, NULL, NULL, NULL, NULL,
  adoption.operation_id, adoption.adoption_digest,
  source.candidate_commit, source.candidate_tree, NULL,
  source.artifact_pins_json, adoption.adoption_id,
  adoption.adoption_digest, adoption.source_evidence_id,
  adoption.source_digest, node.task_id, node.definition_revision,
  node.criteria_revision
FROM execution_remote_evidence_adoptions adoption
JOIN execution_remote_evidence_reuse_contracts reuse
  ON reuse.adoption_id = adoption.adoption_id
  AND reuse.adoption_digest = adoption.adoption_digest
JOIN execution_remote_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
  AND node.revision = adoption.plan_revision
  AND node.node_key = adoption.node_key
WHERE (
  json_array_length(node.node_json, '$.inputs') = 0 OR EXISTS (
    SELECT 1 FROM remote_input_attestations attestation
    WHERE attestation.plan_id = adoption.plan_id
      AND attestation.plan_revision = adoption.plan_revision
      AND attestation.node_key = adoption.node_key
      AND attestation.source_evidence_id = adoption.source_evidence_id
      AND attestation.remote_input_evidence_digest =
        reuse.reuse_input_evidence_digest
  )
)
UNION ALL
SELECT adoption.plan_id, adoption.plan_revision, adoption.node_key,
  adoption.gate,
  json_extract(adoption.adoption_json, '$.sourceExecution.dispatchGeneration'),
  json_extract(adoption.adoption_json, '$.sourceExecution.runId'),
  CASE WHEN json_extract(source.source_json, '$.kind') = 'task_result'
    THEN json_extract(source.source_json, '$.resultId')
    ELSE json_extract(companion.source_json, '$.resultId') END,
  CASE WHEN json_extract(source.source_json, '$.kind') = 'task_result'
    THEN json_extract(source.source_json, '$.resultVersion')
    ELSE json_extract(companion.source_json, '$.resultVersion') END,
  CASE WHEN adoption.gate = 'accepted_result'
    THEN json_extract(adoption.adoption_json, '$.proofs[0].operationId')
    ELSE adoption.operation_id END,
  adoption.adoption_digest,
  json_extract(source.source_json, '$.commit'),
  json_extract(source.source_json, '$.tree'),
  json_extract(source.source_json, '$.origin.checkpointId'),
  json_extract(source.source_json, '$.artifactPins'),
  adoption.adoption_id, adoption.adoption_digest,
  adoption.source_evidence_id, adoption.source_digest,
  node.task_id, node.definition_revision, node.criteria_revision
FROM execution_carried_evidence_adoptions adoption
JOIN execution_carried_evidence_reuse_contracts reuse
  ON reuse.adoption_id = adoption.adoption_id
  AND reuse.adoption_digest = adoption.adoption_digest
JOIN execution_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
LEFT JOIN execution_source_evidence companion
  ON companion.source_evidence_id = json_extract(
    source.source_json, '$.origin.companionSourceEvidenceId'
  )
  AND companion.source_digest = json_extract(
    source.source_json, '$.origin.companionSourceDigest'
  )
JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
  AND node.revision = adoption.plan_revision
  AND node.node_key = adoption.node_key;
