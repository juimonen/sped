#!/bin/bash
SPED_DIR="$HOME/sped"
mkdir -p "$SPED_DIR/audio" "$SPED_DIR/projects"

docker stop sped-e 2>/dev/null

echo "sped-e starting..."
echo "Audio:    $SPED_DIR/audio"
echo "Projects: $SPED_DIR/projects"

docker run --rm -d \
  --name sped-e \
  -p 3000:3000 \
  -v "$SPED_DIR:/workspace" \
  sped > /dev/null

sleep 1

# Open browser completely detached from terminal
nohup sh -c 'open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null' \
  > /dev/null 2>&1 &

echo "Running. To stop: docker stop sped-e"
