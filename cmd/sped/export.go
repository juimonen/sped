package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
)

// ── WAV structures ────────────────────────────────────────────────────────────

type wavHeader struct {
	sampleRate  uint32
	numChannels uint16
	bitsPerSample uint16
}

func readWavHeader(path string) (*wavHeader, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	buf := make([]byte, 12)
	f.Read(buf)
	if string(buf[0:4]) != "RIFF" || string(buf[8:12]) != "WAVE" {
		return nil, 0, fmt.Errorf("not a WAV file: %s", path)
	}

	chunk := make([]byte, 8)
	var hdr wavHeader
	var dataOffset int64
	offset := int64(12)

	for {
		f.Seek(offset, 0)
		n, _ := f.Read(chunk)
		if n < 8 {
			break
		}
		id := string(chunk[0:4])
		size := uint32(chunk[4]) | uint32(chunk[5])<<8 | uint32(chunk[6])<<16 | uint32(chunk[7])<<24

		if id == "fmt " {
			fmtBuf := make([]byte, size)
			f.Read(fmtBuf)
			if len(fmtBuf) >= 16 {
				hdr.numChannels = uint16(fmtBuf[2]) | uint16(fmtBuf[3])<<8
				hdr.sampleRate = uint32(fmtBuf[4]) | uint32(fmtBuf[5])<<8 | uint32(fmtBuf[6])<<16 | uint32(fmtBuf[7])<<24
				hdr.bitsPerSample = uint16(fmtBuf[14]) | uint16(fmtBuf[15])<<8
			}
		} else if id == "data" {
			dataOffset = offset + 8
			break
		}
		offset += 8 + int64(size)
		if size%2 != 0 {
			offset++
		}
	}

	if dataOffset == 0 {
		return nil, 0, fmt.Errorf("no data chunk found in %s", path)
	}
	return &hdr, dataOffset, nil
}

// Read PCM samples from a WAV file region as float64 stereo pairs [-1, 1]
// Returns []float64 interleaved stereo: [L, R, L, R, ...]
func readSamples(path string, offsetSecs, durationSecs float64) ([]float64, *wavHeader, error) {
	hdr, dataOffset, err := readWavHeader(path)
	if err != nil {
		return nil, nil, err
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	bytesPerSample := int64(hdr.bitsPerSample / 8)
	frameSize := bytesPerSample * int64(hdr.numChannels)
	startFrame := int64(offsetSecs * float64(hdr.sampleRate))
	numFrames := int64(durationSecs * float64(hdr.sampleRate))

	f.Seek(dataOffset+startFrame*frameSize, 0)

	// Read raw bytes
	rawBytes := make([]byte, numFrames*frameSize)
	n, _ := f.Read(rawBytes)
	rawBytes = rawBytes[:n]
	actualFrames := int64(n) / frameSize

	// Convert to float64 stereo
	out := make([]float64, actualFrames*2)
	for i := int64(0); i < actualFrames; i++ {
		frameBytes := rawBytes[i*frameSize : i*frameSize+frameSize]
		var left, right float64

		switch hdr.bitsPerSample {
		case 16:
			s := int16(binary.LittleEndian.Uint16(frameBytes[0:2]))
			left = float64(s) / 32768.0
			if hdr.numChannels >= 2 {
				s2 := int16(binary.LittleEndian.Uint16(frameBytes[2:4]))
				right = float64(s2) / 32768.0
			} else {
				right = left
			}
		case 24:
			v := int32(frameBytes[0]) | int32(frameBytes[1])<<8 | int32(frameBytes[2])<<16
			if v&0x800000 != 0 {
				v |= ^0xFFFFFF
			}
			left = float64(v) / 8388608.0
			if hdr.numChannels >= 2 {
				v2 := int32(frameBytes[3]) | int32(frameBytes[4])<<8 | int32(frameBytes[5])<<16
				if v2&0x800000 != 0 {
					v2 |= ^0xFFFFFF
				}
				right = float64(v2) / 8388608.0
			} else {
				right = left
			}
		case 32:
			bits := binary.LittleEndian.Uint32(frameBytes[0:4])
			left = float64(math.Float32frombits(bits))
			if hdr.numChannels >= 2 {
				bits2 := binary.LittleEndian.Uint32(frameBytes[4:8])
				right = float64(math.Float32frombits(bits2))
			} else {
				right = left
			}
		}

		out[i*2] = left
		out[i*2+1] = right
	}

	return out, hdr, nil
}

// Apply linear fade to a stereo sample buffer
func applyFades(samples []float64, fadeIn, fadeOut, sampleRate float64) {
	total := len(samples) / 2
	fadeInFrames := int(fadeIn * sampleRate)
	fadeOutFrames := int(fadeOut * sampleRate)

	for i := 0; i < total; i++ {
		gain := 1.0
		if i < fadeInFrames && fadeInFrames > 0 {
			gain = float64(i) / float64(fadeInFrames)
		}
		if i >= total-fadeOutFrames && fadeOutFrames > 0 {
			gain = float64(total-i) / float64(fadeOutFrames)
		}
		samples[i*2] *= gain
		samples[i*2+1] *= gain
	}
}

// Write stereo 16-bit WAV file
func writeWav(path string, samples []float64, sampleRate uint32) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	numSamples := len(samples) // stereo pairs * 2
	dataSize := uint32(numSamples * 2) // 16-bit = 2 bytes per sample

	// RIFF header
	f.Write([]byte("RIFF"))
	binary.Write(f, binary.LittleEndian, uint32(36+dataSize))
	f.Write([]byte("WAVE"))

	// fmt chunk
	f.Write([]byte("fmt "))
	binary.Write(f, binary.LittleEndian, uint32(16))
	binary.Write(f, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(f, binary.LittleEndian, uint16(2)) // stereo
	binary.Write(f, binary.LittleEndian, sampleRate)
	binary.Write(f, binary.LittleEndian, sampleRate*2*2) // byte rate
	binary.Write(f, binary.LittleEndian, uint16(4))      // block align
	binary.Write(f, binary.LittleEndian, uint16(16))     // bits per sample

	// data chunk
	f.Write([]byte("data"))
	binary.Write(f, binary.LittleEndian, dataSize)

	// Write samples
	for _, s := range samples {
		clamped := math.Max(-1.0, math.Min(1.0, s))
		v := int16(clamped * 32767)
		binary.Write(f, binary.LittleEndian, v)
	}

	return nil
}

func cmdExport(args []string) {
	projectPath := requireProject()
	projectName := filepath.Base(projectPath)

	// Output path
	outPath := projectName + "_export.wav"
	if len(args) > 0 {
		outPath = args[0]
	}
	if !filepath.IsAbs(outPath) {
		outPath = filepath.Join(projectPath, outPath)
	}

	payload := buildPlayPayload(projectPath)
	if len(payload.Tracks) == 0 {
		fmt.Fprintln(os.Stderr, "No tracks to export")
		os.Exit(1)
	}

	// Determine output sample rate and total duration from first non-muted track
	var sampleRate uint32 = 44100
	var totalDuration float64

	for _, track := range payload.Tracks {
		if track.Muted {
			continue
		}
		for _, r := range track.Regions {
			if r.Duration > 0 {
				hdr, _, err := readWavHeader(r.File)
				if err == nil {
					sampleRate = hdr.sampleRate
					break
				}
			}
		}
		break
	}

	// Find total duration
	for _, track := range payload.Tracks {
		if track.Muted {
			continue
		}
		var dur float64
		for _, r := range track.Regions {
			dur += r.Duration
		}
		if dur > totalDuration {
			totalDuration = dur
		}
	}

	if totalDuration == 0 {
		fmt.Fprintln(os.Stderr, "Nothing to export — all tracks are empty or muted")
		os.Exit(1)
	}

	totalFrames := int(totalDuration * float64(sampleRate))
	// Stereo mix buffer
	mix := make([]float64, totalFrames*2)

	fmt.Printf("Exporting %.2fs at %dHz stereo...\n", totalDuration, sampleRate)

	for _, track := range payload.Tracks {
		if track.Muted {
			fmt.Printf("  track %s: skipped (muted)\n", track.ID)
			continue
		}
		gain := track.Gain
		if gain == 0 {
			gain = 1.0
		}

		var cursor float64
		for _, region := range track.Regions {
			if region.Duration <= 0 {
				cursor += region.Duration
				continue
			}

			samples, _, err := readSamples(region.File, region.Offset, region.Duration)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  warning: could not read %s: %v\n", region.File, err)
				cursor += region.Duration
				continue
			}

			// Apply fades
			if region.FadeIn > 0 || region.FadeOut > 0 {
				applyFades(samples, region.FadeIn, region.FadeOut, float64(sampleRate))
			}

			// Mix into buffer at cursor position
			startFrame := int(cursor * float64(sampleRate))
			for i := 0; i < len(samples)/2; i++ {
				mixIdx := (startFrame + i) * 2
				if mixIdx+1 >= len(mix) {
					break
				}
				mix[mixIdx] += samples[i*2] * gain
				mix[mixIdx+1] += samples[i*2+1] * gain
			}

			cursor += region.Duration
		}
		fmt.Printf("  track %s: mixed\n", track.ID)
	}

	// Normalize if clipping
	peak := 0.0
	for _, s := range mix {
		if math.Abs(s) > peak {
			peak = math.Abs(s)
		}
	}
	if peak > 1.0 {
		fmt.Printf("  normalizing (peak: %.3f)\n", peak)
		for i := range mix {
			mix[i] /= peak
		}
	}

	err := writeWav(outPath, mix, sampleRate)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error writing WAV: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Exported: %s\n", outPath)
}

// Satisfy unused import if io not used elsewhere
var _ = io.EOF
