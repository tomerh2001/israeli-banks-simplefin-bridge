# syntax=docker/dockerfile:1
#
# israeli-banks-simplefin-bridge
#
# Multi-stage build on the official puppeteer image, which ships a pinned
# Chrome plus every shared library it needs (the Sure importer proved this
# shape). The app's own puppeteer (pulled in by israeli-bank-scrapers) is told
# never to download a second browser; it is pointed at the bundled one through
# a version-independent symlink resolved at build time.
#
# Stages
#   base     puppeteer image + Xvfb/noVNC for assisted login + bridge wrapper
#   deps     full dependency install (dev deps included, for tsc)
#   build    TypeScript -> dist/
#   messages standalone Google Messages OTP receiver
#   runtime  production dependencies, dist/ and the optional receiver
#
# Expected size (measured 2026-09, linux/amd64): the puppeteer base is ~2.0 GB
# (Chrome and its libraries dominate); the apt layer adds ~350 MB because
# Debian's novnc package drags in python3 + nodejs 18 dependencies; the
# production node_modules are ~70 MB and dist/ is tiny, so the final image is
# ~2.45 GB. Nothing from the deps/build stages (dev dependencies, TypeScript
# sources, yarn cache) is carried over. Replacing the apt novnc package with
# the upstream noVNC tarball would shave ~300 MB if size ever matters.

# ---------------------------------------------------------------------------
# Match the Puppeteer version resolved in yarn.lock; update the base and lock together.
FROM ghcr.io/puppeteer/puppeteer:25.10.0 AS base

USER root

# Assisted login (bridge login <company>) runs Chrome headed under Xvfb and
# exposes it through noVNC; the packages are small enough to keep in the base.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends xvfb xauth tini x11vnc novnc websockify \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

# Never let the app's puppeteer fetch its own Chrome (during install or at run time).
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
	PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

# Stable path to the Chrome bundled in the base image, whatever its version.
RUN ln -s "$(ls -d /home/pptruser/.cache/puppeteer/chrome/*/chrome-linux64/chrome | head -1)" /usr/local/bin/chrome-bundled \
	&& /usr/local/bin/chrome-bundled --version
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-bundled

# `bridge <command>` wrapper for the CLI (used by HEALTHCHECK, CMD and operators).
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/bridge \
	&& chmod 0755 /usr/local/bin/bridge

RUN mkdir -p /app/data && chown -R pptruser:pptruser /app

# ---------------------------------------------------------------------------
FROM base AS deps

USER pptruser
WORKDIR /app

COPY --chown=pptruser:pptruser package.json yarn.lock .yarnrc.yml ./
COPY --chown=pptruser:pptruser .yarn .yarn
RUN yarn install --immutable

# ---------------------------------------------------------------------------
FROM deps AS build

COPY --chown=pptruser:pptruser tsconfig.json tsconfig.build.json ./
COPY --chown=pptruser:pptruser src src
RUN yarn build

# The receiver is a separate program; it does not mirror messages into Matrix.
FROM golang:1.27.1-bookworm AS messages
WORKDIR /src
COPY tools/google-messages-otp/go.mod tools/google-messages-otp/go.sum ./
RUN go mod download
COPY tools/google-messages-otp/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/google-messages-otp .

# ---------------------------------------------------------------------------
FROM base AS runtime

USER pptruser
WORKDIR /app

# Production dependencies only. `yarn workspaces focus` ships with yarn 4
# (workspace-tools is built in) and honours nodeLinker: node-modules.
COPY --chown=pptruser:pptruser package.json yarn.lock .yarnrc.yml ./
COPY --chown=pptruser:pptruser .yarn .yarn
RUN yarn workspaces focus --all --production \
	&& yarn cache clean --all \
	&& rm -rf .yarn/cache .yarn/install-state.gz

# A moving base can silently pair a newer Chrome with an older application driver.
# Check the installed runtime dependency and the actual binary before publishing.
RUN node <<'NODE'
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {PUPPETEER_REVISIONS} = require('puppeteer');
const output = execFileSync(process.env.PUPPETEER_EXECUTABLE_PATH, ['--version'], {encoding: 'utf8'}).trim();
const actual = output.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1];
assert.equal(actual, PUPPETEER_REVISIONS.chrome, `Bundled Chrome (${output}) must match Puppeteer (${PUPPETEER_REVISIONS.chrome})`);
console.log(`Verified Puppeteer browser: Chrome ${actual}`);
NODE

COPY --from=build --chown=pptruser:pptruser /app/dist dist
COPY --from=messages --chmod=0755 /out/google-messages-otp /usr/local/bin/google-messages-otp
COPY tools/google-messages-otp/LICENSE /usr/share/licenses/google-messages-otp/LICENSE
COPY --chown=pptruser:pptruser config.example.json ./
COPY --chmod=0755 scripts/container-entrypoint.sh /usr/local/bin/bridge-entrypoint

ENV DATA_DIR=/app/data \
	CONFIG_PATH=/app/config.json \
	TZ=Asia/Jerusalem \
	NODE_ENV=production

VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=5m --timeout=20s --start-period=60s --retries=3 \
	CMD ["bridge", "health"]

USER pptruser
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/bridge-entrypoint"]
CMD ["bridge", "serve"]
