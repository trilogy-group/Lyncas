#!/bin/bash
# start_webhook.sh — launch the EC2 webhook handler with env loaded
# from agent/.env. Used as the foreground entry-point during manual
# bring-up and as the ExecStart pre-image for the systemd unit (the
# unit itself uses EnvironmentFile= directly, so this script is for
# interactive/SSH use).
#
# Usage:
#   bash agent/start_webhook.sh                 # foreground, Ctrl+C to stop
#   nohup bash agent/start_webhook.sh &         # background, logs to nohup.out
#
# Assumes the repo is checked out at ~/trilogy/Lyncas
# (matches the systemd unit's WorkingDirectory). Edit the cd path if
# your deployment uses a different layout.

set -euo pipefail

cd ~/trilogy/Lyncas

# set -a exports every variable defined by the sourced file so the
# python process inherits them without us having to re-export each
# one by hand. set +a turns the auto-export off again so the rest
# of the script doesn't accidentally export local shell variables.
set -a
. agent/.env
set +a

exec python agent/webhook_handler.py
