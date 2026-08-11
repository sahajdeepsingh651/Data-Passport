#!/bin/bash
echo "Starting Context Bus Backend on 0.0.0.0:8000 (Live)..."
cd store/backend
.venv/bin/python3 .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --env-file ../.env &
BACKEND_PID=$!
cd ../..

echo "Starting Gateway Proxy on 0.0.0.0:8080 (Live)..."
.venv/bin/python3 .venv/bin/uvicorn gateway.app:app --host 0.0.0.0 --port 8080 &
GATEWAY_PID=$!

echo "Services are running! Press Ctrl+C to stop."
trap "kill $BACKEND_PID $GATEWAY_PID" EXIT
wait
