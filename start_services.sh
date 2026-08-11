#!/bin/bash
echo "Starting Context Bus Backend via Docker (Live on port 8000)..."
cd store
docker compose up --build -d
cd ..

echo "Starting Gateway Proxy on 0.0.0.0:8080 (Live)..."
.venv/bin/python3 .venv/bin/uvicorn gateway.app:app --host 0.0.0.0 --port 8080 &
GATEWAY_PID=$!

echo "Services are running! Press Ctrl+C to stop the gateway proxy. (The Context Bus will continue running in Docker until you run 'docker compose down' in the store/ directory)."
trap "kill $GATEWAY_PID" EXIT
wait
