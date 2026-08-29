package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

const upgradeJournalSchemaVersion = 1

const (
	upgradePhasePrepared        = "prepared"
	upgradePhaseServicesStarted = "services_started"
	upgradePhaseTargetReady     = "target_ready"
)

type upgradeJournal struct {
	SchemaVersion int           `json:"schemaVersion"`
	Phase         string        `json:"phase"`
	Previous      Manifest      `json:"previous"`
	Target        Manifest      `json:"target"`
	Backup        backupReceipt `json:"backup"`
	CreatedAt     string        `json:"createdAt"`
	UpdatedAt     string        `json:"updatedAt"`
}

func newUpgradeJournal(
	previous,
	target Manifest,
	backup backupReceipt,
	now time.Time,
) upgradeJournal {
	timestamp := now.UTC().Format(time.RFC3339Nano)
	return upgradeJournal{
		SchemaVersion: upgradeJournalSchemaVersion,
		Phase:         upgradePhasePrepared,
		Previous:      previous,
		Target:        target,
		Backup:        backup,
		CreatedAt:     timestamp,
		UpdatedAt:     timestamp,
	}
}

func saveUpgradeJournal(path string, journal upgradeJournal) error {
	if err := validateUpgradeJournal(journal); err != nil {
		return err
	}
	value, err := jsonMarshalIndentLine(journal)
	if err != nil {
		return err
	}
	return writeAtomic(path, value, 0o600)
}

func loadUpgradeJournal(path string) (upgradeJournal, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return upgradeJournal{}, false, nil
	}
	if err != nil {
		return upgradeJournal{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return upgradeJournal{}, false, actionError(
			"UPGRADE_JOURNAL_INVALID",
			"the pending upgrade journal is not a private regular file",
			"Restore the original 0600 journal and retry only the recorded target upgrade.",
			nil,
		)
	}
	value, err := readBoundedFile(path, 2<<20)
	if err != nil {
		return upgradeJournal{}, false, err
	}
	var journal upgradeJournal
	if err := decodeStrictJSON(value, &journal); err != nil {
		return upgradeJournal{}, false, actionError(
			"UPGRADE_JOURNAL_INVALID",
			"the pending upgrade journal is malformed",
			"Restore the exact journal from host backup; do not infer either revision.",
			err,
		)
	}
	if err := validateUpgradeJournal(journal); err != nil {
		return upgradeJournal{}, false, actionError(
			"UPGRADE_JOURNAL_INVALID",
			"the pending upgrade journal violates its revision boundary",
			"Restore the exact journal and release directories before retrying the recorded target.",
			err,
		)
	}
	return journal, true, nil
}

func rejectPendingUpgrade(installation Installation) error {
	journal, found, err := loadUpgradeJournal(installation.UpgradeJournalPath)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	return actionError(
		"UPGRADE_RECOVERY_REQUIRED",
		fmt.Sprintf(
			"an interrupted upgrade to %s remains in phase %s",
			journal.Target.ReleaseVersion,
			journal.Phase,
		),
		"Retry convenewirectl upgrade with the exact recorded target release and checksum pin; every other lifecycle action is blocked.",
		nil,
	)
}

func validateUpgradeJournal(journal upgradeJournal) error {
	if journal.SchemaVersion != upgradeJournalSchemaVersion {
		return fmt.Errorf("unsupported upgrade journal schema")
	}
	switch journal.Phase {
	case upgradePhasePrepared, upgradePhaseServicesStarted, upgradePhaseTargetReady:
	default:
		return fmt.Errorf("unsupported upgrade phase %q", journal.Phase)
	}
	if _, err := time.Parse(time.RFC3339Nano, journal.CreatedAt); err != nil {
		return fmt.Errorf("createdAt is invalid: %w", err)
	}
	if _, err := time.Parse(time.RFC3339Nano, journal.UpdatedAt); err != nil {
		return fmt.Errorf("updatedAt is invalid: %w", err)
	}
	if err := validateManifest(journal.Previous); err != nil {
		return fmt.Errorf("previous manifest: %w", err)
	}
	if err := validateManifest(journal.Target); err != nil {
		return fmt.Errorf("target manifest: %w", err)
	}
	if err := validateBackupReceiptBoundary(journal.Previous.DataRoot, journal.Backup); err != nil {
		return fmt.Errorf("backup receipt: %w", err)
	}
	if journal.Previous.LastSuccessfulStep != "ready" ||
		journal.Target.LastSuccessfulStep != "upgrade_validating" {
		return fmt.Errorf("journal revisions do not own the expected lifecycle steps")
	}
	if journal.Target.DataSchemaVersion < journal.Previous.DataSchemaVersion ||
		(journal.Target.ReleaseVersion == journal.Previous.ReleaseVersion &&
			journal.Target.ReleaseDigest == journal.Previous.ReleaseDigest) {
		return fmt.Errorf("journal target is not a forward release change")
	}
	previousBoundary := journal.Previous
	targetBoundary := journal.Target
	clearUpgradeReleaseFields(&previousBoundary)
	clearUpgradeReleaseFields(&targetBoundary)
	if !reflect.DeepEqual(previousBoundary, targetBoundary) {
		return fmt.Errorf("upgrade journal changes installation authority outside release identity")
	}
	return nil
}

func clearUpgradeReleaseFields(manifest *Manifest) {
	manifest.ReleaseVersion = ""
	manifest.SourceCommit = ""
	manifest.ReleaseDir = ""
	manifest.ReleaseDigest = ""
	manifest.DataSchemaVersion = 0
	manifest.ServerImage = ""
	manifest.CaddyImage = ""
	manifest.RuntimeImagePlatform = ""
	manifest.LastSuccessfulStep = ""
	manifest.UpdatedAt = ""
}

func manifestsEqualIgnoringUpdatedAt(left, right Manifest) bool {
	left.UpdatedAt = ""
	right.UpdatedAt = ""
	return reflect.DeepEqual(left, right)
}

func manifestIsCommittedUpgradeTarget(current, target Manifest) bool {
	expected := target
	expected.Generation++
	expected.LastSuccessfulStep = "ready"
	return manifestsEqualIgnoringUpdatedAt(current, expected)
}

func advanceUpgradeJournal(path string, journal *upgradeJournal, phase string, now time.Time) error {
	if upgradePhaseRank(journal.Phase) >= upgradePhaseRank(phase) {
		return nil
	}
	journal.Phase = phase
	journal.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	return saveUpgradeJournal(path, *journal)
}

func upgradePhaseRank(phase string) int {
	switch phase {
	case upgradePhasePrepared:
		return 1
	case upgradePhaseServicesStarted:
		return 2
	case upgradePhaseTargetReady:
		return 3
	default:
		return 0
	}
}

func removeUpgradeJournal(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	return directory.Close()
}

func jsonMarshalIndentLine(value any) ([]byte, error) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}
