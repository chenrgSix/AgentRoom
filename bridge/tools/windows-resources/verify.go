package main

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"unicode/utf16"

	"github.com/tc-hib/winres"
)

func verifyExecutable(path string, expected *winres.ResourceSet) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return errors.New("PE input must be a bounded regular executable")
	}
	parsed, err := pe.NewFile(file)
	if err != nil {
		return fmt.Errorf("invalid PE executable: %w", err)
	}
	defer parsed.Close()
	if parsed.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return errors.New("expected a Windows amd64 PE executable")
	}
	optional, ok := parsed.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || optional.NumberOfRvaAndSizes <= pe.IMAGE_DIRECTORY_ENTRY_RESOURCE {
		return errors.New("PE resource directory is missing")
	}
	directory := optional.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
	if directory.VirtualAddress == 0 || directory.Size == 0 || directory.Size > 4<<20 {
		return errors.New("PE icon resource directory is missing or oversized")
	}
	var section *pe.Section
	for _, candidate := range parsed.Sections {
		if uint64(directory.VirtualAddress) >= uint64(candidate.VirtualAddress) &&
			uint64(directory.VirtualAddress)+uint64(directory.Size) <= uint64(candidate.VirtualAddress)+uint64(candidate.Size) {
			section = candidate
			break
		}
	}
	if section == nil || section.Size > 4<<20 {
		return errors.New("PE resource directory is outside a bounded section")
	}
	raw, err := section.Data()
	if err != nil {
		return fmt.Errorf("read PE resources: %w", err)
	}
	resources, err := readPEResources(raw, section.VirtualAddress, directory.VirtualAddress-section.VirtualAddress)
	if err != nil {
		return err
	}
	count := 0
	var mismatch error
	resources.Walk(func(typeID, resourceID winres.Identifier, language uint16, data []byte) bool {
		if typeID != winres.RT_ICON && typeID != winres.RT_GROUP_ICON {
			return true
		}
		count++
		wanted := expected.Get(typeID, resourceID, language)
		if wanted == nil || !bytes.Equal(data, wanted) {
			mismatch = errors.New("PE icon is corrupt, incomplete, or does not match the current product mark")
			return false
		}
		return true
	})
	if mismatch != nil {
		return mismatch
	}
	if count != expected.Count() {
		return errors.New("PE is missing the product icon groups or one of their seven images")
	}
	return nil
}

// Parse the actual three-level PE resource directory. Bounds and node budgets
// are checked before allocation; malformed offsets cannot trigger unbounded
// recursion, repeated-directory work, or allocation based on an arbitrary PE.
func readPEResources(raw []byte, base, root uint32) (*winres.ResourceSet, error) {
	resources := &winres.ResourceSet{}
	seen := map[uint32]bool{}
	nodes := 0
	within := func(offset, size uint32) bool { return uint64(offset)+uint64(size) <= uint64(len(raw)) }
	identifier := func(value uint32) (winres.Identifier, error) {
		if value&0x80000000 == 0 {
			if value > 65535 {
				return nil, errors.New("PE resource numeric identifier is invalid")
			}
			return winres.ID(value), nil
		}
		offset := root + (value & 0x7fffffff)
		if offset < root || !within(offset, 2) {
			return nil, errors.New("PE resource name is out of bounds")
		}
		length := uint32(binary.LittleEndian.Uint16(raw[offset:]))
		if length > 128 || !within(offset+2, length*2) {
			return nil, errors.New("PE resource name exceeds its limit")
		}
		units := make([]uint16, length)
		for index := range units {
			units[index] = binary.LittleEndian.Uint16(raw[int(offset)+2+2*index:])
		}
		return winres.Name(string(utf16.Decode(units))), nil
	}
	var walk func(uint32, int, winres.Identifier, winres.Identifier) error
	walk = func(offset uint32, depth int, typeID, resourceID winres.Identifier) error {
		if depth > 2 || seen[offset] || !within(offset, 16) {
			return errors.New("PE resource directory is corrupt or cyclic")
		}
		seen[offset] = true
		entries := uint32(binary.LittleEndian.Uint16(raw[offset+12:])) + uint32(binary.LittleEndian.Uint16(raw[offset+14:]))
		if entries > 64 || !within(offset+16, entries*8) {
			return errors.New("PE resource directory exceeds its entry limit")
		}
		for index := uint32(0); index < entries; index++ {
			nodes++
			if nodes > 256 {
				return errors.New("PE resource tree exceeds its node limit")
			}
			entry := raw[offset+16+index*8:]
			id, err := identifier(binary.LittleEndian.Uint32(entry))
			if err != nil {
				return err
			}
			target := binary.LittleEndian.Uint32(entry[4:])
			next := root + (target & 0x7fffffff)
			if next < root {
				return errors.New("PE resource offset overflow")
			}
			if depth < 2 {
				if target&0x80000000 == 0 {
					return errors.New("PE resource directory level is missing")
				}
				if depth == 0 {
					err = walk(next, 1, id, nil)
				} else {
					err = walk(next, 2, typeID, id)
				}
				if err != nil {
					return err
				}
			} else {
				language, ok := id.(winres.ID)
				if !ok || target&0x80000000 != 0 || !within(next, 16) {
					return errors.New("PE resource language or leaf is invalid")
				}
				rva, size := binary.LittleEndian.Uint32(raw[next:]), binary.LittleEndian.Uint32(raw[next+4:])
				if rva < base || size > 1<<20 || !within(rva-base, size) {
					return errors.New("PE resource image is out of bounds")
				}
				if resources.Get(typeID, resourceID, uint16(language)) != nil {
					return errors.New("PE resource is duplicated")
				}
				if err := resources.Set(typeID, resourceID, uint16(language), raw[rva-base:rva-base+size]); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(root, 0, nil, nil); err != nil {
		return nil, err
	}
	return resources, nil
}
