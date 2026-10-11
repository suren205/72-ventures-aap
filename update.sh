#!/bin/bash
# Get the newest app code from GitHub and restart. Your records are not touched.
set -e
cd "$(dirname "$0")"
git fetch -q
git reset -q --hard @{u}
sudo systemctl restart khata
echo "Updated and restarted. Done."
