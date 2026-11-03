#!/bin/sh
# Builds the addon and installs the extension to ~/.pi/agent/extensions/docsearch.
# Afterwards: pi-bolt compile --only klar-ui,docsearch   (compiles it into the executable)
set -e
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH" cargo build --release -p docsearch-node
dest="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/docsearch"
mkdir -p "$dest"
cp extension/index.ts "$dest/index.ts"
cp target/release/libdocsearch_node.so "$dest/docsearch.linux-x64.node"
echo "installed to $dest"
