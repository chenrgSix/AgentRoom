package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strconv"
	"strings"
)

// normalizeSVG preserves source geometry while expanding two SVG shorthands
// unsupported by the pinned oksvg parser: omitted rect ry/rx defaults and
// adjacent one-character arc flags. It never substitutes product geometry.
// See https://www.w3.org/TR/SVG2/shapes.html#RectElement and
// https://www.w3.org/TR/SVG2/paths.html#PathDataBNF.
func normalizeSVG(source []byte) ([]byte, error) {
	if err := validateSVG(source); err != nil {
		return nil, err
	}
	decoder := xml.NewDecoder(bytes.NewReader(source))
	var output bytes.Buffer
	encoder := xml.NewEncoder(&output)
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			// The original namespace was validated. Emit it only on the root,
			// instead of allowing encoding/xml to duplicate the declaration.
			value.Name.Space = ""
			if value.Name.Local == "rect" {
				rx, ry := "", ""
				for _, attribute := range value.Attr {
					if attribute.Name.Local == "rx" {
						rx = attribute.Value
					}
					if attribute.Name.Local == "ry" {
						ry = attribute.Value
					}
				}
				if rx != "" && ry == "" {
					value.Attr = append(value.Attr, xml.Attr{Name: xml.Name{Local: "ry"}, Value: rx})
				} else if ry != "" && rx == "" {
					value.Attr = append(value.Attr, xml.Attr{Name: xml.Name{Local: "rx"}, Value: ry})
				}
			}
			for index := range value.Attr {
				if value.Attr[index].Name.Local == "d" {
					value.Attr[index].Value, err = normalizePath(value.Attr[index].Value)
					if err != nil {
						return nil, err
					}
				}
			}
			token = value
		case xml.EndElement:
			value.Name.Space = ""
			token = value
		}
		if err := encoder.EncodeToken(token); err != nil {
			return nil, err
		}
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// This is lexical normalization, not an alternate path renderer. Coordinates
// still come exclusively from mark.svg and curves are rasterized by oksvg.
func normalizePath(path string) (string, error) {
	var output strings.Builder
	position := 0
	first := true
	for position < len(path) {
		for position < len(path) && strings.ContainsRune(" \t\r\n", rune(path[position])) {
			position++
		}
		if position == len(path) {
			break
		}
		command := path[position]
		upper := command
		if upper >= 'a' && upper <= 'z' {
			upper -= 'a' - 'A'
		}
		arity := map[byte]int{'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'T': 2, 'A': 7, 'Z': 0}[upper]
		if !strings.ContainsRune("MLHVCSQTAZ", rune(upper)) || (first && upper != 'M') {
			return "", errors.New("unsupported or malformed SVG path command")
		}
		first = false
		position++
		output.WriteByte(command)
		if arity == 0 {
			output.WriteByte(' ')
			continue
		}
		count := 0
		for {
			for position < len(path) && strings.ContainsRune(" \t\r\n", rune(path[position])) {
				position++
			}
			if position < len(path) && path[position] == ',' {
				if count == 0 {
					return "", errors.New("SVG path has a leading comma")
				}
				position++
				for position < len(path) && strings.ContainsRune(" \t\r\n", rune(path[position])) {
					position++
				}
				if position == len(path) || strings.ContainsRune(",MmLlHhVvCcSsQqTtAaZz", rune(path[position])) {
					return "", errors.New("SVG path has a repeated or trailing comma")
				}
			}
			if position == len(path) || strings.ContainsRune("MmLlHhVvCcSsQqTtAaZz", rune(path[position])) {
				break
			}
			var number string
			if upper == 'A' && (count%arity == 3 || count%arity == 4) {
				if path[position] != '0' && path[position] != '1' {
					return "", errors.New("SVG arc flag must be zero or one")
				}
				number = path[position : position+1]
				position++
			} else {
				match := pathNumbers.FindStringIndex(path[position:])
				if match == nil || match[0] != 0 {
					return "", errors.New("malformed SVG path number")
				}
				number = path[position : position+match[1]]
				position += match[1]
				// Canonical decimal syntax also avoids oksvg's incomplete
				// handling of plus signs and uppercase exponent markers.
				value, err := strconv.ParseFloat(number, 64)
				if err != nil || value < -4096 || value > 4096 {
					return "", errors.New("SVG path coordinate exceeds its limit")
				}
				number = strconv.FormatFloat(value, 'f', -1, 64)
			}
			output.WriteByte(' ')
			output.WriteString(number)
			count++
		}
		if count == 0 || count%arity != 0 {
			return "", errors.New("SVG path command has incomplete arguments")
		}
		output.WriteByte(' ')
	}
	if first {
		return "", errors.New("SVG path is empty")
	}
	return output.String(), nil
}
