# Stage 1: build both Go binaries
FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o sped-server .
COPY cmd/sped/ ./cmd/sped/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o sped ./cmd/sped/

# Stage 2: minimal runtime — just Alpine + bash
FROM alpine:3.19
RUN apk add --no-cache bash

WORKDIR /app
COPY --from=builder /build/sped-server ./sped-server
COPY --from=builder /build/sped /usr/local/bin/sped
COPY public/ ./public/

RUN mkdir -p /workspace && chmod 777 /workspace
ENV HOME=/workspace
ENV DOCKER=1
ENV SHELL=/bin/bash
WORKDIR /workspace
EXPOSE 3000

RUN printf '#!/bin/sh\numask 000\nexec /app/sped-server\n' > /start.sh && chmod +x /start.sh
CMD ["/start.sh"]
