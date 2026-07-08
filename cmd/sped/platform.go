package main

import (
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func setupSignal(ch chan os.Signal) {
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
}

func httpGet(url string) (*http.Response, error) {
	return http.Get(url)
}
