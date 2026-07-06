# sped-e — Sound Processing Editor Enhanced

A non-destructive multitrack audio editor with a browser-based interface and command-line editing workflow. Work is done entirely through shell commands; the browser provides real-time visualization and Web Audio playback.

sped-e is a modern reimplementation of ideas from the original SPED (Sound Processing Kit Editor), presented at ICMC 2007:

> Uimonen, J. (2007). *SPED – A Sound File Editor*. Proceedings of the International Computer Music Conference 2007.
> http://hdl.handle.net/2027/spo.bbp2372.2007.094

The original SPED used XML-based edit decision lists and the SPKit C++ signal processing framework. sped-e brings the same non-destructive EDL concept to the browser using Web Audio API, with multitrack support and a Docker-based distribution model.

---

## Requirements

- Docker

That's it. No Node.js, npm, or audio libraries needed on the host.

---

## Building the Docker image

```bash
git clone https://github.com/jauimone/sped.git
cd sped
docker build -t sped .
```

The build compiles node-pty from source inside the Alpine container — this takes a few minutes the first time.

---

## Launching

Copy the launcher script and make it executable:

```bash
cp sped-launch.sh ~/sped-launch.sh
chmod +x ~/sped-launch.sh
~/sped-launch.sh
```

This will:
- Create `~/sped/projects/` if it doesn't exist
- Start the sped-e container
- Open your browser at `http://localhost:3000`

To stop:

```bash
docker stop sped-e
```

---

## Usage

sped-e can only see files inside `~/sped/`. Copy audio files from your machine into a project's audio folder before importing.

### Quick start

```bash
# In the browser shell:
sped open myproject

# On your host machine (outside sped):
cp ~/myrecordings/audio.wav ~/sped/projects/myproject/audio/

# Back in the browser shell:
sped import audio.wav
sped play
```

### Commands

```
sped open <name>                open or create a project
sped import <file.wav> [track] [start|end|<t>]  import audio to track
sped track                      show active track
sped track <id>                 set active track
sped tracks                     list all tracks
sped mute [track]               mute a track
sped unmute [track]             unmute a track
sped solo [track]               solo a track
sped unsolo                     unmute all tracks

sped status                     show active track EDL and audio files
sped copy <start> <end> [slot]  copy region to slot (default slot 0)
sped slots                      list copy slots
sped join <slot> [slot...]      build new EDL from slots in order
sped cut  <start> <end>         cut region out
sped paste <t>                  paste at timeline position
sped undo                       revert active track to previous EDL

sped play                       play all tracks mixed (Ctrl+C to stop)
sped play <start> <end>         play a region
sped active                     show active project
```

All times are in seconds.

### Multitrack workflow

```bash
sped open myfilm
# Copy audio files to ~/sped/projects/myfilm/audio/
sped import dialogue.wav        # → track 1
sped import music.wav 2         # → track 2
sped import sfx.wav 3           # → track 3

sped mute 2                     # mute music while editing dialogue
sped copy 10.0 15.0 1           # copy region to slot 1
sped copy 45.0 50.0 2           # copy region to slot 2
sped join 1 2 1                 # build new EDL from slots
sped play
```

### Granular scripting

Since the browser shell is real bash, you can script:

```bash
# 100 random 1-second cuts joined into a montage
for i in $(seq 1 100); do
  START=$((RANDOM % 300))
  sped copy $START $((START + 1)) $i
done
sped join $(seq 1 100 | tr '\n' ' ')
sped play
```

---

## Project structure

Each project is self-contained under `~/sped/projects/<name>/`:

```
~/sped/
  projects/
    myfilm/
      audio/          ← copy WAV files here from outside sped
      tracks/
        track_1/
          edl_0000.json
          edl_0001.json
          current
          slots/
        track_2/
          ...
      active_track
      play.json
```

Projects can be copied or moved freely — all paths inside EDL files are absolute so audio files need to stay in the same location.

---

## Architecture

sped-e separates editing from playback:

- **Shell commands** manipulate JSON edit decision lists (EDLs) on disk — no audio processing at edit time
- **`sped play`** sends the current EDL to the browser over WebSocket
- **Browser** instantiates a Web Audio graph from the EDL and plays it — `AudioBufferSourceNode` per region, scheduled with sample-accurate timing
- The right panel visualizes the EDL, Web Audio node graph, and timeline for each track

This is the same architecture as the original SPED: the EDL is the primary artifact, and the audio engine is only invoked at play time.

---

## License

BSD 3-Clause — see LICENSE file.
