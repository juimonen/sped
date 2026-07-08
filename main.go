package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
)

const port = "3000"

var (
	globalDir   = filepath.Join(os.Getenv("HOME"), ".sped")
	activeFile  = filepath.Join(globalDir, ".sped", "active")
	clients     = make(map[*websocket.Conn]bool)
	clientsMu   sync.Mutex
	shutdownTimer *time.Timer
)

func init() {
	activeFile = filepath.Join(os.Getenv("HOME"), ".sped", "active")
	os.MkdirAll(filepath.Dir(activeFile), 0755)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func getActiveProject() string {
	data, err := os.ReadFile(activeFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func broadcast(msg map[string]interface{}) {
	data, _ := json.Marshal(msg)
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for c := range clients {
		c.WriteMessage(websocket.TextMessage, data)
	}
}

func scheduleShutdown() {
	clientsMu.Lock()
	count := len(clients)
	clientsMu.Unlock()
	if count > 0 {
		return
	}
	if shutdownTimer != nil {
		shutdownTimer.Stop()
	}
	shutdownTimer = time.AfterFunc(2*time.Second, func() {
		clientsMu.Lock()
		count := len(clients)
		clientsMu.Unlock()
		if count == 0 {
			log.Println("No clients — shutting down")
			os.Exit(0)
		}
	})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WS upgrade error:", err)
		return
	}

	clientsMu.Lock()
	clients[conn] = true
	if shutdownTimer != nil {
		shutdownTimer.Stop()
		shutdownTimer = nil
	}
	clientsMu.Unlock()

	log.Println("Browser connected")

	// Send current state as update (no autoplay)
	projectPath := getActiveProject()
	if projectPath != "" {
		for _, fname := range []string{"update.json", "play.json"} {
			fpath := filepath.Join(projectPath, fname)
			if data, err := os.ReadFile(fpath); err == nil {
				var payload interface{}
				if json.Unmarshal(data, &payload) == nil {
					msg, _ := json.Marshal(map[string]interface{}{
						"type":    "update",
						"payload": payload,
					})
					conn.WriteMessage(websocket.TextMessage, msg)
					break
				}
			}
		}
	}

	// Spawn shell via PTY
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	// Make sure sped bin is on PATH
	binPath := "/app/bin"
	envPath := os.Getenv("PATH")
	if !strings.Contains(envPath, binPath) {
		envPath = binPath + ":" + envPath
	}

	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(),
		"PATH="+envPath,
		"PS1=sped> ",
		"TERM=xterm-256color",
	)
	cmd.Dir = "/workspace"

	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Println("PTY error:", err)
		msg, _ := json.Marshal(map[string]interface{}{
			"type": "terminal",
			"data": "\r\n[shell unavailable: " + err.Error() + "]\r\n",
		})
		conn.WriteMessage(websocket.TextMessage, msg)
	} else {
		log.Printf("Shell spawned (pid %d)", cmd.Process.Pid)

		// PTY → browser
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := ptmx.Read(buf)
				if err != nil {
					break
				}
				msg, _ := json.Marshal(map[string]interface{}{
					"type": "terminal",
					"data": string(buf[:n]),
				})
				conn.WriteMessage(websocket.TextMessage, msg)
			}
		}()

		// Cleanup on exit
		go func() {
			cmd.Wait()
			ptmx.Close()
		}()
	}

	// Handle messages from browser
	defer func() {
		conn.Close()
		clientsMu.Lock()
		delete(clients, conn)
		clientsMu.Unlock()
		if ptmx != nil {
			ptmx.Close()
		}
		if cmd != nil && cmd.Process != nil {
			cmd.Process.Kill()
		}
		log.Println("Browser disconnected")
		scheduleShutdown()
	}()

	for {
		_, rawMsg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg map[string]interface{}
		if json.Unmarshal(rawMsg, &msg) != nil {
			continue
		}

		switch msg["type"] {
		case "terminal":
			if ptmx != nil {
				if data, ok := msg["data"].(string); ok {
					ptmx.Write([]byte(data))
				}
			}
		case "resize":
			if ptmx != nil {
				cols := uint16(80)
				rows := uint16(24)
				if c, ok := msg["cols"].(float64); ok {
					cols = uint16(c)
				}
				if r, ok := msg["rows"].(float64); ok {
					rows = uint16(r)
				}
				pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
			}
		case "playback_status":
			// Write status file for CLI polling
			projectPath := getActiveProject()
			if projectPath != "" {
				statusPath := filepath.Join(projectPath, "playback_status.json")
				data, _ := json.Marshal(map[string]interface{}{
					"currentTime": msg["currentTime"],
					"duration":    msg["duration"],
					"playing":     msg["playing"],
					"ts":          time.Now().UnixMilli(),
				})
				os.WriteFile(statusPath, data, 0666)
			}
		}
	}
}

func watchProject(watcher *fsnotify.Watcher) {
	var currentProject string
	var debounce *time.Timer

	// Watch global config for project switches
	go func() {
		for {
			select {
			case event := <-watcher.Events:
				fname := filepath.Base(event.Name)

				// Project switched
				if event.Name == activeFile {
					newProject := getActiveProject()
					if newProject != currentProject && newProject != "" {
						if currentProject != "" {
							watcher.Remove(currentProject)
						}
						currentProject = newProject
						watcher.Add(newProject)
						log.Println("Watching project:", newProject)
						broadcast(map[string]interface{}{
							"type": "project",
							"path": newProject,
						})
					}
					continue
				}

				// Files in project dir
				switch fname {
				case "stop.json":
					broadcast(map[string]interface{}{"type": "stop"})

				case "update.json":
					if debounce != nil {
						debounce.Stop()
					}
					path := event.Name
					debounce = time.AfterFunc(50*time.Millisecond, func() {
						data, err := os.ReadFile(path)
						if err != nil {
							return
						}
						var payload interface{}
						if json.Unmarshal(data, &payload) == nil {
							broadcast(map[string]interface{}{
								"type":    "update",
								"payload": payload,
							})
						}
					})

				case "play.json":
					if debounce != nil {
						debounce.Stop()
					}
					path := event.Name
					debounce = time.AfterFunc(50*time.Millisecond, func() {
						data, err := os.ReadFile(path)
						if err != nil {
							return
						}
						var payload interface{}
						if json.Unmarshal(data, &payload) == nil {
							broadcast(map[string]interface{}{
								"type": "edl",
								"edl":  payload,
							})
						}
					})
				}

			case err := <-watcher.Errors:
				log.Println("Watcher error:", err)
			}
		}
	}()

	// Start watching global dir and current project
	watcher.Add(filepath.Dir(activeFile))
	if p := getActiveProject(); p != "" {
		currentProject = p
		watcher.Add(p)
		log.Println("Watching project:", p)
	}
}

func main() {
	// Serve audio files
	http.HandleFunc("/audio", func(w http.ResponseWriter, r *http.Request) {
		file := r.URL.Query().Get("file")
		if file == "" {
			http.Error(w, "no file", 400)
			return
		}
		abs, err := filepath.Abs(file)
		if err != nil || !strings.HasPrefix(abs, "/workspace") {
			http.Error(w, "forbidden", 403)
			return
		}
		http.ServeFile(w, r, abs)
	})

	// Stop endpoint
	http.HandleFunc("/stop", func(w http.ResponseWriter, r *http.Request) {
		broadcast(map[string]interface{}{"type": "stop"})
		fmt.Fprintln(w, "ok")
	})

	// WebSocket
	http.HandleFunc("/ws", handleWS)

	// Static files
	http.Handle("/", http.FileServer(http.Dir("/app/public")))

	// File watcher
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatal("Watcher error:", err)
	}
	defer watcher.Close()
	watchProject(watcher)

	log.Printf("sped server at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, nil))
}
