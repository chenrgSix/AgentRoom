//go:build windows

package durablefs

// Windows does not expose the POSIX directory-fsync durability barrier. Every
// caller flushes the replacement file before its atomic rename; there is no
// additional directory handle operation that Go can apply portably here.
func syncDirectory(string) error {
	return nil
}
