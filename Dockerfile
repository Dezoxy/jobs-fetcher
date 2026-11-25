# syntax=docker/dockerfile:1
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG CLAUDE_CLI_VERSION
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl python3 python3-venv && rm -rf /var/lib/apt/lists/*
# Indeed collector (scripts/fetch-indeed.py): python-jobspy in its own venv, every
# wheel hash-pinned for this interpreter (Debian trixie python3 3.13). pip check
# proves the --no-deps closure is complete; pip/setuptools and the packages' own
# test suites (~60 MB, mostly pandas/tests, never imported at runtime) are removed.
COPY runtime/requirements-indeed.txt /tmp/requirements-indeed.txt
RUN python3 -m venv /opt/indeed \
    && /opt/indeed/bin/pip install --no-cache-dir --disable-pip-version-check \
       --require-hashes --only-binary :all: --no-deps -r /tmp/requirements-indeed.txt \
    && /opt/indeed/bin/pip check \
    && /opt/indeed/bin/python -m pip uninstall -y -q pip setuptools \
    && find /opt/indeed/lib -depth -type d -name tests -exec rm -r {} + \
    && /opt/indeed/bin/python -I -c 'import jobspy, pandas' \
    && rm /tmp/requirements-indeed.txt
# Preserve the VM's native CLI distribution and measured version.
RUN test -n "$CLAUDE_CLI_VERSION" \
    && install_home="$(mktemp -d)" && installer="$(mktemp)" \
    && curl -fsSL https://claude.ai/install.sh -o "$installer" \
    && HOME="$install_home" bash "$installer" "$CLAUDE_CLI_VERSION" \
    && install -m 0755 "$install_home/.local/bin/claude" /usr/local/bin/claude \
    && rm -rf "$install_home" "$installer"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY scripts/ ./scripts/
COPY docs/judge-prompt.md ./docs/judge-prompt.md
COPY runtime/ ./runtime/
RUN mkdir -p /data/employee-cv && chown -R node:node /data
ENV HOME=/home/node DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=/tmp/claude
# The release this image was built as (YYYY.M.N, from release.yml). Each run
# records it in last-run.json as engineVersion; the site footer shows it. Last,
# so a new version never invalidates the layers above. "dev" for CI builds.
ARG ENGINE_VERSION=dev
ENV ENGINE_VERSION=${ENGINE_VERSION}
USER node
ENTRYPOINT ["node", "/app/scripts/cloud-run.mjs"]
CMD ["refresh"]
