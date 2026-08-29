package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var upgradeBackupNamePattern = regexp.MustCompile(`^convene-wire-[A-Za-z0-9._-]+\.sqlite$`)

type backupReceipt struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func parseBackupReceipt(dataRoot, output string) (backupReceipt, error) {
	line := strings.TrimSuffix(output, "\n")
	if line == output || strings.Contains(line, "\r") {
		return backupReceipt{}, fmt.Errorf("backup command must emit a newline-terminated receipt")
	}
	lines := strings.Split(line, "\n")
	receiptLine := lines[len(lines)-1]
	digest, backupPath, found := strings.Cut(receiptLine, "  ")
	if !found {
		return backupReceipt{}, fmt.Errorf("backup receipt separator is missing")
	}
	receipt, err := inspectBackup(dataRoot, backupPath)
	if err != nil {
		return backupReceipt{}, err
	}
	if digest != receipt.SHA256 {
		return backupReceipt{}, fmt.Errorf("backup command digest does not match the durable host copy")
	}
	return receipt, nil
}

func syncBackupReceipt(dataRoot string, receipt backupReceipt) error {
	if err := verifyBackupReceipt(dataRoot, receipt); err != nil {
		return err
	}
	file, err := os.Open(receipt.Path)
	if err != nil {
		return fmt.Errorf("open backup for durability sync: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync backup file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close synced backup file: %w", err)
	}
	directory, err := os.Open(filepath.Join(dataRoot, "exports"))
	if err != nil {
		return fmt.Errorf("open backup directory for durability sync: %w", err)
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return fmt.Errorf("sync backup directory: %w", err)
	}
	if err := directory.Close(); err != nil {
		return fmt.Errorf("close synced backup directory: %w", err)
	}
	return verifyBackupReceipt(dataRoot, receipt)
}

func validateBackupReceiptBoundary(dataRoot string, receipt backupReceipt) error {
	if err := validateBackupPath(dataRoot, receipt.Path); err != nil {
		return err
	}
	if !hashPattern.MatchString(receipt.SHA256) {
		return fmt.Errorf("backup digest is invalid")
	}
	if receipt.Size < 1 {
		return fmt.Errorf("backup size is invalid")
	}
	return nil
}

func validateBackupPath(dataRoot, backupPath string) error {
	exports := filepath.Join(dataRoot, "exports")
	if !filepath.IsAbs(backupPath) || filepath.Clean(backupPath) != backupPath ||
		filepath.Dir(backupPath) != exports ||
		!upgradeBackupNamePattern.MatchString(filepath.Base(backupPath)) {
		return fmt.Errorf("backup path is outside the installation exports directory")
	}
	return nil
}

func verifyBackupReceipt(dataRoot string, receipt backupReceipt) error {
	if err := validateBackupReceiptBoundary(dataRoot, receipt); err != nil {
		return err
	}
	actual, err := inspectBackup(dataRoot, receipt.Path)
	if err != nil {
		return err
	}
	if actual.SHA256 != receipt.SHA256 || actual.Size != receipt.Size {
		return fmt.Errorf("backup content no longer matches its durable receipt")
	}
	return nil
}

func inspectBackup(dataRoot, backupPath string) (backupReceipt, error) {
	if err := validateBackupPath(dataRoot, backupPath); err != nil {
		return backupReceipt{}, err
	}
	exports := filepath.Join(dataRoot, "exports")
	directory, err := os.Lstat(exports)
	if err != nil {
		return backupReceipt{}, fmt.Errorf("inspect backup directory: %w", err)
	}
	if !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 ||
		directory.Mode().Perm()&0o077 != 0 {
		return backupReceipt{}, fmt.Errorf("backup directory must be a private real directory")
	}
	before, err := os.Lstat(backupPath)
	if err != nil {
		return backupReceipt{}, fmt.Errorf("inspect backup file: %w", err)
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 ||
		before.Mode().Perm()&0o077 != 0 || before.Size() < 1 {
		return backupReceipt{}, fmt.Errorf("backup must be a private non-empty regular file")
	}
	file, err := os.Open(backupPath)
	if err != nil {
		return backupReceipt{}, fmt.Errorf("open backup file: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return backupReceipt{}, fmt.Errorf("backup file changed while it was opened")
	}
	digest, err := digestReader(file)
	if err != nil {
		return backupReceipt{}, fmt.Errorf("hash backup file: %w", err)
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(opened, after) || after.Size() != opened.Size() ||
		!after.ModTime().Equal(opened.ModTime()) {
		return backupReceipt{}, fmt.Errorf("backup file changed while it was hashed")
	}
	return backupReceipt{
		Path: backupPath, SHA256: digest, Size: after.Size(),
	}, nil
}

func digestReader(reader io.Reader) (string, error) {
	digest := sha256.New()
	if _, err := io.Copy(digest, reader); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
