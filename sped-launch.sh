#!/bin/bash
SPED_DIR="$HOME/sped"
mkdir -p "$SPED_DIR/projects"

docker stop sped-e 2>/dev/null

echo "sped-e starting..."
echo "Projects: $SPED_DIR/projects/"
echo ""
echo "To add audio to a project:"
echo "  cp myfile.wav $SPED_DIR/projects/<name>/audio/"
echo ""

docker run --rm -d \
  --name sped-e \
  -p 3000:3000 \
  -v "$SPED_DIR:/workspace" \
  sped > /dev/null

sleep 1
nohup sh -c 'open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null' \
  > /dev/null 2>&1 &
disown

echo "Running at http://localhost:3000"
echo "To stop: docker stop sped-e"
