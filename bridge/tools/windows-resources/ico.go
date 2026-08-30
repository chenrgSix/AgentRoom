package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
)

func encodeICO(images []*image.RGBA) ([]byte, error) {
	headerSize := 6 + len(images)*16
	result := make([]byte, headerSize)
	binary.LittleEndian.PutUint16(result[2:4], 1)
	binary.LittleEndian.PutUint16(result[4:6], uint16(len(images)))
	for index, image := range images {
		size := image.Bounds().Dx()
		var payload []byte
		if size == 256 {
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, image); err != nil {
				return nil, err
			}
			payload = encoded.Bytes()
		} else {
			payload = encodeIconDIB(image)
		}
		entry := result[6+16*index : 6+16*(index+1)]
		entry[0], entry[1] = byte(size), byte(size) // 0 means 256.
		binary.LittleEndian.PutUint16(entry[4:6], 1)
		binary.LittleEndian.PutUint16(entry[6:8], 32)
		binary.LittleEndian.PutUint32(entry[8:12], uint32(len(payload)))
		binary.LittleEndian.PutUint32(entry[12:16], uint32(len(result)))
		result = append(result, payload...)
	}
	return result, nil
}

// Small ICO frames use bottom-up, unpremultiplied 32-bit BGRA DIBs with a
// DWORD-aligned 1-bit AND mask. Inno Setup can consume these without PNG support.
func encodeIconDIB(source image.Image) []byte {
	size := source.Bounds().Dx()
	pixels := size * size * 4
	maskStride := ((size + 31) / 32) * 4
	result := make([]byte, 40+pixels+maskStride*size)
	binary.LittleEndian.PutUint32(result[0:4], 40)
	binary.LittleEndian.PutUint32(result[4:8], uint32(size))
	binary.LittleEndian.PutUint32(result[8:12], uint32(size*2))
	binary.LittleEndian.PutUint16(result[12:14], 1)
	binary.LittleEndian.PutUint16(result[14:16], 32)
	binary.LittleEndian.PutUint32(result[20:24], uint32(pixels))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			pixel := color.NRGBAModel.Convert(source.At(x, y)).(color.NRGBA)
			row := size - 1 - y
			offset := 40 + (row*size+x)*4
			copy(result[offset:offset+4], []byte{pixel.B, pixel.G, pixel.R, pixel.A})
			if pixel.A == 0 {
				result[40+pixels+row*maskStride+x/8] |= 1 << (7 - uint(x%8))
			}
		}
	}
	return result
}
