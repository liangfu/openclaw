#!/usr/bin/env sh
# Rebuild + reinstall OpenClaw from source and restart the gateway service.
# Re-runs postinstall patches (pi-ai GPT-6 reasoning + mantle thinking),
# rebuilds dist/, then restarts the systemd user service.
set -eu

REPO="${OPENCLAW_REPO:-$HOME/workspace/openclaw}"
BRANCH="${OPENCLAW_BRANCH:-add-bedrock-auth-support}"
CLI="${OPENCLAW_CLI:-$HOME/.local/bin/openclaw}"

# Put nvm's node on PATH if the system has none (gateway/systemd env may lack it).
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$NODE_BIN" ] && PATH="$NODE_BIN:$PATH" && export PATH
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found on PATH" >&2; exit 1; }

cd "$REPO"

# 1) Sync source.
git fetch origin
git checkout "$BRANCH"
git pull --ff-only

# 2) Install deps (runs postinstall patches).
pnpm install

# 3) Re-apply patches explicitly (idempotent; covers --frozen installs).
node scripts/patch-openai-reasoning.mjs
node scripts/patch-mantle-thinking.mjs

# 4) Rebuild the bundle the gateway runs.
pnpm build

# 5) Restart + verify.
# if [ -x "$CLI" ]; then OC="$CLI"; else OC="openclaw"; fi
# "$OC" gateway restart
# "$OC" gateway status | head -5
