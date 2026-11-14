#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo 'Bitte .env.example nach .env kopieren und OWNER_EMAIL eintragen.'
  exit 1
fi
exec node server.js
