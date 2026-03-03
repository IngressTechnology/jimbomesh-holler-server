#!/bin/bash
# JimboMesh Holler Server — HTTP Health Server
# Launches the Node.js health server. Replaces the previous socat + bash approach
# to eliminate shell-per-connection injection risk.

exec node /opt/jimbomesh-still/health-server.js
