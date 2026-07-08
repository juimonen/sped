package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ── Types ────────────────────────────────────────────────────────────────────

type Region struct {
	File     string  `json:"file"`
	Offset   float64 `json:"offset"`
	Duration float64 `json:"duration"`
	FadeIn   float64 `json:"fadeIn"`
	FadeOut  float64 `json:"fadeOut"`
}

type EDL struct {
	Regions []Region `json:"regions"`
}

type TrackPayload struct {
	ID      string   `json:"id"`
	Regions []Region `json:"regions"`
	Muted   bool     `json:"muted"`
	Gain    float64  `json:"gain"`
}

type PlayPayload struct {
	Tracks []TrackPayload `json:"tracks"`
}

type SlotRef struct {
	EDLIndex int     `json:"edlIndex"`
	Start    float64 `json:"start"`
	End      float64 `json:"end"`
}

type TrackMeta struct {
	Muted bool    `json:"muted"`
	Gain  float64 `json:"gain"`
}

// ── Store ────────────────────────────────────────────────────────────────────

var globalDir = filepath.Join(os.Getenv("HOME"), ".sped")
var activeFile = filepath.Join(globalDir, "active")

func getActiveProject() string {
	data, err := os.ReadFile(activeFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func setActiveProject(p string) {
	os.MkdirAll(globalDir, 0755)
	os.WriteFile(activeFile, []byte(p), 0644)
}

func trackDir(projectPath, trackID string) string {
	return filepath.Join(projectPath, "tracks", "track_"+trackID)
}

func edlPath(dir string, idx int) string {
	return filepath.Join(dir, fmt.Sprintf("edl_%04d.json", idx))
}

func currentIndex(dir string) int {
	data, err := os.ReadFile(filepath.Join(dir, "current"))
	if err != nil {
		return -1
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return n
}

func readEDL(dir string) *EDL {
	idx := currentIndex(dir)
	if idx < 0 {
		return nil
	}
	data, err := os.ReadFile(edlPath(dir, idx))
	if err != nil {
		return nil
	}
	var edl EDL
	json.Unmarshal(data, &edl)
	return &edl
}

func writeEDL(dir string, edl *EDL) int {
	idx := currentIndex(dir) + 1
	os.MkdirAll(dir, 0777)
	data, _ := json.MarshalIndent(edl, "", "  ")
	os.WriteFile(edlPath(dir, idx), data, 0666)
	os.WriteFile(filepath.Join(dir, "current"), []byte(strconv.Itoa(idx)), 0666)
	return idx
}

func undoEDL(dir string) bool {
	idx := currentIndex(dir)
	if idx <= 0 {
		return false
	}
	os.WriteFile(filepath.Join(dir, "current"), []byte(strconv.Itoa(idx-1)), 0666)
	return true
}

func getActiveTrack(projectPath string) string {
	data, err := os.ReadFile(filepath.Join(projectPath, "active_track"))
	if err != nil {
		return "1"
	}
	return strings.TrimSpace(string(data))
}

func setActiveTrack(projectPath, trackID string) {
	os.WriteFile(filepath.Join(projectPath, "active_track"), []byte(trackID), 0666)
}

func listTracks(projectPath string) []string {
	tracksDir := filepath.Join(projectPath, "tracks")
	entries, err := os.ReadDir(tracksDir)
	if err != nil {
		return nil
	}
	var tracks []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "track_") {
			tracks = append(tracks, strings.TrimPrefix(e.Name(), "track_"))
		}
	}
	sort.Slice(tracks, func(i, j int) bool {
		a, _ := strconv.Atoi(tracks[i])
		b, _ := strconv.Atoi(tracks[j])
		return a < b
	})
	return tracks
}

func readTracksMeta(projectPath string) map[string]TrackMeta {
	data, err := os.ReadFile(filepath.Join(projectPath, "tracks", "meta.json"))
	if err != nil {
		return map[string]TrackMeta{}
	}
	var m map[string]TrackMeta
	json.Unmarshal(data, &m)
	return m
}

func setTrackMeta(projectPath, trackID string, meta TrackMeta) {
	all := readTracksMeta(projectPath)
	if all == nil {
		all = map[string]TrackMeta{}
	}
	// Merge
	existing := all[trackID]
	if meta.Gain == 0 {
		meta.Gain = existing.Gain
	}
	all[trackID] = meta
	data, _ := json.MarshalIndent(all, "", "  ")
	os.MkdirAll(filepath.Join(projectPath, "tracks"), 0777)
	os.WriteFile(filepath.Join(projectPath, "tracks", "meta.json"), data, 0666)
}

func slotPath(dir, slot string) string {
	return filepath.Join(dir, "slots", "slot_"+slot+".json")
}

func writeSlot(dir, slot string, edlIdx int, start, end float64) {
	os.MkdirAll(filepath.Join(dir, "slots"), 0777)
	ref := SlotRef{EDLIndex: edlIdx, Start: start, End: end}
	data, _ := json.MarshalIndent(ref, "", "  ")
	os.WriteFile(slotPath(dir, slot), data, 0666)
}

func readSlot(dir, slot string) *SlotRef {
	data, err := os.ReadFile(slotPath(dir, slot))
	if err != nil {
		return nil
	}
	var ref SlotRef
	json.Unmarshal(data, &ref)
	return &ref
}

func listSlots(dir string) []string {
	slotsDir := filepath.Join(dir, "slots")
	entries, err := os.ReadDir(slotsDir)
	if err != nil {
		return nil
	}
	var slots []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "slot_") && strings.HasSuffix(e.Name(), ".json") {
			slot := strings.TrimSuffix(strings.TrimPrefix(e.Name(), "slot_"), ".json")
			slots = append(slots, slot)
		}
	}
	sort.Slice(slots, func(i, j int) bool {
		a, _ := strconv.Atoi(slots[i])
		b, _ := strconv.Atoi(slots[j])
		return a < b
	})
	return slots
}

func resolveSlot(dir, slot string) []Region {
	ref := readSlot(dir, slot)
	if ref == nil {
		return nil
	}
	edl := &EDL{}
	data, err := os.ReadFile(edlPath(dir, ref.EDLIndex))
	if err != nil {
		return nil
	}
	json.Unmarshal(data, edl)
	return extractRegions(edl.Regions, ref.Start, ref.End)
}

func buildPlayPayload(projectPath string) PlayPayload {
	meta := readTracksMeta(projectPath)
	tracks := listTracks(projectPath)
	var payload PlayPayload
	for _, id := range tracks {
		dir := trackDir(projectPath, id)
		edl := readEDL(dir)
		if edl == nil {
			continue
		}
		m := meta[id]
		gain := m.Gain
		if gain == 0 {
			gain = 1.0
		}
		payload.Tracks = append(payload.Tracks, TrackPayload{
			ID:      id,
			Regions: edl.Regions,
			Muted:   m.Muted,
			Gain:    gain,
		})
	}
	return payload
}

func signalPlay(projectPath string, payload PlayPayload) {
	data, _ := json.MarshalIndent(payload, "", "  ")
	os.WriteFile(filepath.Join(projectPath, "play.json"), data, 0666)
}

func signalUpdate(projectPath string, payload PlayPayload) {
	data, _ := json.MarshalIndent(payload, "", "  ")
	os.WriteFile(filepath.Join(projectPath, "update.json"), data, 0666)
}

func update(projectPath string) {
	payload := buildPlayPayload(projectPath)
	signalUpdate(projectPath, payload)
}

// ── EDL operations ───────────────────────────────────────────────────────────

func totalDuration(regions []Region) float64 {
	var t float64
	for _, r := range regions {
		t += r.Duration
	}
	return t
}

func extractRegions(regions []Region, start, end float64) []Region {
	var result []Region
	var cursor float64
	for _, r := range regions {
		rStart := cursor
		rEnd := cursor + r.Duration
		if rEnd <= start || rStart >= end {
			cursor += r.Duration
			continue
		}
		clipStart := math.Max(start, rStart) - rStart
		clipEnd := math.Min(end, rEnd) - rStart
		nr := r
		nr.Offset = r.Offset + clipStart
		nr.Duration = clipEnd - clipStart
		result = append(result, nr)
		cursor += r.Duration
	}
	return result
}

func cutRegions(regions []Region, start, end float64) []Region {
	var result []Region
	var cursor float64
	for _, r := range regions {
		rStart := cursor
		rEnd := cursor + r.Duration
		if rEnd <= start || rStart >= end {
			result = append(result, r)
		} else {
			if rStart < start {
				nr := r
				nr.Duration = start - rStart
				nr.FadeOut = 0
				result = append(result, nr)
			}
			if rEnd > end {
				nr := r
				nr.Offset = r.Offset + (end - rStart)
				nr.Duration = rEnd - end
				nr.FadeIn = 0
				result = append(result, nr)
			}
		}
		cursor += r.Duration
	}
	return result
}

func pasteRegions(regions []Region, clip []Region, t float64) []Region {
	var result []Region
	var cursor float64
	inserted := false
	for _, r := range regions {
		rEnd := cursor + r.Duration
		if !inserted && t <= rEnd {
			localOffset := t - cursor
			if localOffset <= 0 {
				result = append(result, clip...)
				result = append(result, r)
			} else if localOffset >= r.Duration {
				result = append(result, r)
				result = append(result, clip...)
			} else {
				before := r
				before.Duration = localOffset
				before.FadeOut = 0
				after := r
				after.Offset = r.Offset + localOffset
				after.Duration = r.Duration - localOffset
				after.FadeIn = 0
				result = append(result, before)
				result = append(result, clip...)
				result = append(result, after)
			}
			inserted = true
		} else {
			result = append(result, r)
		}
		cursor += r.Duration
	}
	if !inserted {
		result = append(result, clip...)
	}
	return result
}

// ── WAV duration ─────────────────────────────────────────────────────────────

func wavDuration(path string) float64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	buf := make([]byte, 12)
	f.Read(buf)
	if string(buf[0:4]) != "RIFF" || string(buf[8:12]) != "WAVE" {
		return 0
	}

	chunk := make([]byte, 8)
	var sampleRate, numChannels, bitsPerSample uint32
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
				numChannels = uint32(fmtBuf[2]) | uint32(fmtBuf[3])<<8
				sampleRate = uint32(fmtBuf[4]) | uint32(fmtBuf[5])<<8 | uint32(fmtBuf[6])<<16 | uint32(fmtBuf[7])<<24
				bitsPerSample = uint32(fmtBuf[14]) | uint32(fmtBuf[15])<<8
			}
		} else if id == "data" {
			if sampleRate == 0 || numChannels == 0 || bitsPerSample == 0 {
				break
			}
			bytesPerSample := bitsPerSample / 8
			totalSamples := float64(size) / float64(numChannels*bytesPerSample)
			return totalSamples / float64(sampleRate)
		}
		offset += 8 + int64(size)
		if size%2 != 0 {
			offset++
		}
	}
	return 0
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func fmtTime(t float64) string {
	m := int(t / 60)
	s := t - float64(m*60)
	return fmt.Sprintf("%d:%05.2f", m, s)
}

func parseTime(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}

func requireProject() string {
	p := getActiveProject()
	if p == "" {
		fmt.Fprintln(os.Stderr, "No active project. Run: sped open <name>")
		os.Exit(1)
	}
	return p
}

func requireTrackDir(projectPath string) (string, string) {
	trackID := getActiveTrack(projectPath)
	dir := trackDir(projectPath, trackID)
	return dir, trackID
}

func requireEDL(dir string) *EDL {
	edl := readEDL(dir)
	if edl == nil {
		fmt.Fprintln(os.Stderr, "Track has no EDL yet. Run: sped import <file.wav>")
		os.Exit(1)
	}
	return edl
}

func audioFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	audioExt := regexp.MustCompile(`(?i)\.(wav|mp3|flac|aiff|ogg)$`)
	var files []string
	for _, e := range entries {
		if !e.IsDir() && audioExt.MatchString(e.Name()) {
			files = append(files, e.Name())
		}
	}
	return files
}

// ── Commands ─────────────────────────────────────────────────────────────────

func cmdOpen(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: sped open <name>")
		os.Exit(1)
	}
	name := args[0]
	absPath := filepath.Join("/workspace/projects", name)
	audioDir := filepath.Join(absPath, "audio")
	existed := len(listTracks(absPath)) > 0

	os.MkdirAll(absPath, 0777)
	os.MkdirAll(audioDir, 0777)
	setActiveProject(absPath)

	hostPath := "~/sped/projects/" + name + "/audio/"
	if existed {
		tracks := listTracks(absPath)
		files := audioFiles(audioDir)
		fmt.Printf("Resumed: %s\n", name)
		fmt.Printf("Audio:   %s (%d file(s))\n", hostPath, len(files))
		if len(tracks) > 0 {
			fmt.Printf("Tracks:  %s  (active: %s)\n", strings.Join(tracks, ", "), getActiveTrack(absPath))
		}
	} else {
		fmt.Printf("Created: %s\n\n", name)
		fmt.Println("sped can only see ~/sped/ — copy audio from outside sped:")
		fmt.Printf("  cp yourfile.wav %s\n\n", hostPath)
		fmt.Println("Then run: sped import <file.wav>")
	}
}

func cmdImport(args []string) {
	projectPath := requireProject()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: sped import <file.wav> [track] [start|end|<t>]")
		os.Exit(1)
	}

	file := args[0]
	audioDir := filepath.Join(projectPath, "audio")
	absFile := filepath.Join(audioDir, file)
	if _, err := os.Stat(absFile); err != nil {
		absFile, _ = filepath.Abs(file)
		if _, err := os.Stat(absFile); err != nil {
			fmt.Fprintf(os.Stderr, "File not found: %s\nCopy it to projects/%s/audio/ first\n",
				file, filepath.Base(projectPath))
			os.Exit(1)
		}
	}

	duration := wavDuration(absFile)
	if duration == 0 {
		fmt.Fprintf(os.Stderr, "Could not read WAV header: %s\n", absFile)
		os.Exit(1)
	}

	trackID := getActiveTrack(projectPath)
	position := "end"
	if len(args) > 1 {
		if args[1] == "start" || args[1] == "end" || strings.Contains(args[1], ".") {
			position = args[1]
		} else {
			trackID = args[1]
			if len(args) > 2 {
				position = args[2]
			}
		}
	}

	dir := trackDir(projectPath, trackID)
	existing := readEDL(dir)

	newRegion := Region{File: absFile, Offset: 0, Duration: duration}
	var newRegions []Region

	if existing == nil {
		newRegions = []Region{newRegion}
	} else if position == "end" {
		newRegions = append(existing.Regions, newRegion)
	} else if position == "start" {
		newRegions = append([]Region{newRegion}, existing.Regions...)
	} else {
		t, _ := strconv.ParseFloat(position, 64)
		newRegions = pasteRegions(existing.Regions, []Region{newRegion}, t)
	}

	edl := &EDL{Regions: newRegions}
	if existing != nil {
		edl = &EDL{Regions: newRegions}
	}
	idx := writeEDL(dir, edl)
	setActiveTrack(projectPath, trackID)

	fmt.Printf("Imported %s (%.3fs) -> track %s EDL #%d\n",
		filepath.Base(file), duration, trackID, idx)
	update(projectPath)
}

func cmdTrack(args []string) {
	projectPath := requireProject()
	if len(args) == 0 {
		fmt.Printf("Active track: %s\n", getActiveTrack(projectPath))
	} else {
		setActiveTrack(projectPath, args[0])
		fmt.Printf("Active track: %s\n", args[0])
	}
}

func cmdTracks(args []string) {
	projectPath := requireProject()
	tracks := listTracks(projectPath)
	meta := readTracksMeta(projectPath)
	active := getActiveTrack(projectPath)
	if len(tracks) == 0 {
		fmt.Println("No tracks. Run: sped import <file.wav>")
		return
	}
	fmt.Println("Tracks:")
	for _, id := range tracks {
		dir := trackDir(projectPath, id)
		edl := readEDL(dir)
		m := meta[id]
		flags := ""
		if m.Muted {
			flags += " [muted]"
		}
		if id == active {
			flags += " *"
		}
		if edl != nil {
			dur := totalDuration(edl.Regions)
			fmt.Printf("  track %s: %d region(s), %.3fs%s\n", id, len(edl.Regions), dur, flags)
		} else {
			fmt.Printf("  track %s: empty%s\n", id, flags)
		}
	}
}

func cmdStatus(args []string) {
	projectPath := requireProject()
	projectName := filepath.Base(projectPath)
	dir, trackID := requireTrackDir(projectPath)
	edl := requireEDL(dir)
	idx := currentIndex(dir)

	audioDir := filepath.Join(projectPath, "audio")
	files := audioFiles(audioDir)
	hostPath := "~/sped/projects/" + projectName + "/audio/"

	fmt.Printf("Project: %s  (track %s active)\n", projectName, trackID)
	fmt.Printf("Audio:   %s\n", hostPath)
	if len(files) == 0 {
		fmt.Println("  (empty — copy WAV files here)")
	} else {
		for _, f := range files {
			fmt.Println("  " + f)
		}
	}

	fmt.Printf("EDL #%d - %d region(s)\n", idx, len(edl.Regions))
	var cursor float64
	for i, r := range edl.Regions {
		fmt.Printf("  [%d] %s  offset=%.3fs  dur=%.3fs  @ %.3fs\n",
			i, filepath.Base(r.File), r.Offset, r.Duration, cursor)
		cursor += r.Duration
	}
	fmt.Printf("  Total: %.3fs\n", totalDuration(edl.Regions))
}

func cmdCopy(args []string) {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: sped copy <start> <end> [slot]")
		os.Exit(1)
	}
	start, _ := parseTime(args[0])
	end, _ := parseTime(args[1])
	if end <= start {
		fmt.Fprintln(os.Stderr, "end must be > start")
		os.Exit(1)
	}
	slot := "0"
	if len(args) > 2 {
		slot = args[2]
	}
	projectPath := requireProject()
	dir, _ := requireTrackDir(projectPath)
	idx := currentIndex(dir)
	writeSlot(dir, slot, idx, start, end)
	fmt.Printf("Slot %s: [%.3fs - %.3fs] (%.3fs)\n", slot, start, end, end-start)
}

func cmdSlots(args []string) {
	projectPath := requireProject()
	dir, _ := requireTrackDir(projectPath)
	slots := listSlots(dir)
	if len(slots) == 0 {
		fmt.Println("No slots.")
		return
	}
	fmt.Println("Slots:")
	for _, slot := range slots {
		ref := readSlot(dir, slot)
		if ref != nil {
			fmt.Printf("  [%s] EDL #%d  %.3fs - %.3fs  (%.3fs)\n",
				slot, ref.EDLIndex, ref.Start, ref.End, ref.End-ref.Start)
		}
	}
}

func cmdJoin(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: sped join <slot> [slot...]")
		os.Exit(1)
	}
	projectPath := requireProject()
	dir, _ := requireTrackDir(projectPath)
	edl := requireEDL(dir)

	var newRegions []Region
	for _, slot := range args {
		regions := resolveSlot(dir, slot)
		if regions == nil {
			fmt.Fprintf(os.Stderr, "Slot %s not found\n", slot)
			os.Exit(1)
		}
		dur := totalDuration(regions)
		fmt.Printf("  slot %s: %.3fs\n", slot, dur)
		newRegions = append(newRegions, regions...)
	}

	newEDL := &EDL{Regions: newRegions}
	_ = edl
	idx := writeEDL(dir, newEDL)
	fmt.Printf("Joined %d slot(s) -> %.3fs -> EDL #%d\n",
		len(args), totalDuration(newRegions), idx)
	update(projectPath)
}

func cmdCut(args []string) {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: sped cut <start> <end>")
		os.Exit(1)
	}
	start, _ := parseTime(args[0])
	end, _ := parseTime(args[1])
	if end <= start {
		fmt.Fprintln(os.Stderr, "end must be > start")
		os.Exit(1)
	}
	projectPath := requireProject()
	dir, _ := requireTrackDir(projectPath)
	edl := requireEDL(dir)

	// Save to slot 0
	clipped := extractRegions(edl.Regions, start, end)
	writeSlot(dir, "0", currentIndex(dir), start, end)
	_ = clipped

	newRegions := cutRegions(edl.Regions, start, end)
	idx := writeEDL(dir, &EDL{Regions: newRegions})
	fmt.Printf("Cut %.3fs -> EDL #%d\n", end-start, idx)
	update(projectPath)
}

func cmdPaste(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: sped paste <t> [slot]")
		os.Exit(1)
	}
	t, _ := parseTime(args[0])
	slot := "0"
	if len(args) > 1 {
		slot = args[1]
	}
	projectPath := requireProject()
	dir, _ := requireTrackDir(projectPath)
	edl := requireEDL(dir)

	regions := resolveSlot(dir, slot)
	if regions == nil {
		fmt.Fprintf(os.Stderr, "Slot %s is empty. Use: sped copy <start> <end> [slot]\n", slot)
		os.Exit(1)
	}

	newRegions := pasteRegions(edl.Regions, regions, t)
	idx := writeEDL(dir, &EDL{Regions: newRegions})
	dur := totalDuration(regions)
	fmt.Printf("Pasted slot %s (%.3fs) at %.3fs -> EDL #%d\n", slot, dur, t, idx)
	update(projectPath)
}

func cmdUndo(args []string) {
	projectPath := requireProject()
	dir, trackID := requireTrackDir(projectPath)
	if undoEDL(dir) {
		edl := readEDL(dir)
		fmt.Printf("Undo track %s -> EDL #%d (%d region(s))\n",
			trackID, currentIndex(dir), len(edl.Regions))
		update(projectPath)
	} else {
		fmt.Println("Nothing to undo")
	}
}

func cmdMute(args []string) {
	projectPath := requireProject()
	trackID := getActiveTrack(projectPath)
	if len(args) > 0 {
		trackID = args[0]
	}
	m := readTracksMeta(projectPath)[trackID]
	m.Muted = true
	setTrackMeta(projectPath, trackID, m)
	fmt.Printf("Muted track %s\n", trackID)
	update(projectPath)
}

func cmdUnmute(args []string) {
	projectPath := requireProject()
	trackID := getActiveTrack(projectPath)
	if len(args) > 0 {
		trackID = args[0]
	}
	m := readTracksMeta(projectPath)[trackID]
	m.Muted = false
	setTrackMeta(projectPath, trackID, m)
	fmt.Printf("Unmuted track %s\n", trackID)
	update(projectPath)
}

func cmdSolo(args []string) {
	projectPath := requireProject()
	soloID := getActiveTrack(projectPath)
	if len(args) > 0 {
		soloID = args[0]
	}
	for _, id := range listTracks(projectPath) {
		m := readTracksMeta(projectPath)[id]
		m.Muted = id != soloID
		setTrackMeta(projectPath, id, m)
	}
	fmt.Printf("Solo track %s\n", soloID)
	update(projectPath)
}

func cmdUnsolo(args []string) {
	projectPath := requireProject()
	for _, id := range listTracks(projectPath) {
		m := readTracksMeta(projectPath)[id]
		m.Muted = false
		setTrackMeta(projectPath, id, m)
	}
	fmt.Println("All tracks unmuted")
	update(projectPath)
}

func cmdPlay(args []string) {
	projectPath := requireProject()

	var payload PlayPayload
	var totalDur float64

	if len(args) > 0 && args[0] == "slot" {
		slotID := "0"
		if len(args) > 1 {
			slotID = args[1]
		}
		dir, _ := requireTrackDir(projectPath)
		regions := resolveSlot(dir, slotID)
		if regions == nil {
			fmt.Fprintf(os.Stderr, "Slot %s is empty\n", slotID)
			os.Exit(1)
		}
		totalDur = totalDuration(regions)
		payload = PlayPayload{Tracks: []TrackPayload{{ID: "slot", Regions: regions, Gain: 1.0}}}
		fmt.Printf("Playing slot %s (%.3fs)\n", slotID, totalDur)
	} else {
		payload = buildPlayPayload(projectPath)

		if len(args) >= 1 {
			startTime, err1 := parseTime(args[0])
			var endTime float64
			var err2 error
			if len(args) >= 2 {
				endTime, err2 = parseTime(args[1])
			}
			if err1 == nil {
				activeTrack := getActiveTrack(projectPath)
				var filtered []TrackPayload
				for _, t := range payload.Tracks {
					if t.ID == activeTrack {
						total := totalDuration(t.Regions)
						s := startTime
						e := total
						if err2 == nil {
							e = endTime
						}
						t.Regions = extractRegions(t.Regions, s, e)
					}
					filtered = append(filtered, t)
				}
				payload.Tracks = filtered
			}
		}

		for _, t := range payload.Tracks {
			if !t.Muted {
				d := totalDuration(t.Regions)
				if d > totalDur {
					totalDur = d
				}
			}
		}
	}

	signalPlay(projectPath, payload)

	// Block with wall-clock counter
	statusPath := filepath.Join(projectPath, "playback_status.json")
	os.Remove(statusPath)

	fmt.Printf("\r\u25b6 0:00.00 / %s  [Ctrl+C to stop]", fmtTime(totalDur))

	startedAt := float64(nowMs())
	ticker := make(chan bool)

	go func() {
		for {
			time.Sleep(100 * time.Millisecond)
			ticker <- true
		}
	}()

	// Handle Ctrl+C
	sigCh := make(chan os.Signal, 1)
	setupSignal(sigCh)

	for {
		select {
		case <-sigCh:
			fmt.Println()
			// Signal browser to stop
			resp, err := httpGet("http://localhost:3000/stop")
			if err == nil {
				resp.Body.Close()
			}
			os.Exit(0)
		case <-ticker:
			var currentTime float64
			if data, err := os.ReadFile(statusPath); err == nil {
				var status map[string]interface{}
				if json.Unmarshal(data, &status) == nil {
					if ts, ok := status["ts"].(float64); ok {
						if float64(nowMs())-ts < 2000 {
							if ct, ok := status["currentTime"].(float64); ok {
								currentTime = ct
							}
							if playing, ok := status["playing"].(bool); ok && !playing && currentTime > 0 {
								fmt.Println()
								os.Exit(0)
							}
						}
					}
				}
			}
			if currentTime == 0 {
				currentTime = (float64(nowMs()) - startedAt) / 1000
			}
			fmt.Printf("\r\u25b6 %s / %s  [Ctrl+C to stop]", fmtTime(currentTime), fmtTime(totalDur))
			if currentTime >= totalDur-0.1 {
				fmt.Println()
				os.Exit(0)
			}
		}
	}
}

func cmdActive(args []string) {
	p := getActiveProject()
	if p != "" {
		fmt.Printf("Active project: %s\n", p)
	} else {
		fmt.Println("No active project. Run: sped open <name>")
	}
}

func cmdHelp(args []string) {
	fmt.Println(`sped-e — non-destructive multitrack audio editor

  sped open <name>               open or create a project in projects/<name>
  sped import <file> [track] [start|end|<t>]  import from project audio folder
  sped track                     show active track
  sped track <id>                set active track
  sped tracks                    list all tracks
  sped mute [track]              mute a track
  sped unmute [track]            unmute a track
  sped solo [track]              solo a track
  sped unsolo                    unmute all tracks

  sped status                    show active track EDL and audio files
  sped copy <start> <end> [slot] copy region to slot (default 0)
  sped slots                     list copy slots
  sped join <slot> [slot...]     build new EDL from slots in order
  sped cut  <start> <end>        cut region out (also saves to slot 0)
  sped paste <t> [slot]          paste slot at timeline position
  sped undo                      revert active track EDL

  sped play                      play all tracks mixed (Ctrl+C to stop)
  sped play slot <n>             audition a copy slot
  sped play <start> <end>        play a region
  sped active                    show active project

All times in seconds.`)
}

// ── Platform helpers (signal, http, time) ─────────────────────────────────────

func nowMs() int64 {
	return time.Now().UnixMilli()
}

// main ─────────────────────────────────────────────────────────────────────────

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		cmdHelp(nil)
		return
	}

	cmd := args[0]
	rest := args[1:]

	switch cmd {
	case "open":
		cmdOpen(rest)
	case "import":
		cmdImport(rest)
	case "track":
		cmdTrack(rest)
	case "tracks":
		cmdTracks(rest)
	case "status":
		cmdStatus(rest)
	case "copy":
		cmdCopy(rest)
	case "slots":
		cmdSlots(rest)
	case "join":
		cmdJoin(rest)
	case "cut":
		cmdCut(rest)
	case "paste":
		cmdPaste(rest)
	case "undo":
		cmdUndo(rest)
	case "mute":
		cmdMute(rest)
	case "unmute":
		cmdUnmute(rest)
	case "solo":
		cmdSolo(rest)
	case "unsolo":
		cmdUnsolo(rest)
	case "play":
		cmdPlay(rest)
	case "active":
		cmdActive(rest)
	case "help", "--help", "-h":
		cmdHelp(rest)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nRun 'sped help' for usage.\n", cmd)
		os.Exit(1)
	}
}
