package repository

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func directoryIdentity(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != filepath.Clean(path) {
		return "", ErrChanged
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return "", ErrChanged
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", ErrChanged
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", ErrChanged
	}
	defer windows.CloseHandle(handle)
	var data windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &data) != nil || data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "", ErrChanged
	}
	return fmt.Sprintf("%d:%d:%d", data.VolumeSerialNumber, data.FileIndexHigh, data.FileIndexLow), nil
}
