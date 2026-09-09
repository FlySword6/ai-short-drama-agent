# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.11-slim@sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff
FROM ${PYTHON_IMAGE}

ARG NODE_VERSION=22.19.0
ARG NPM_VERSION=11.11.0
ARG TARGETARCH

RUN --mount=type=bind,source=docker/node-dist,target=/tmp/node-dist \
    set -eux; \
    case "${TARGETARCH}" in \
      arm64) node_arch="arm64"; node_sha256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc" ;; \
      amd64) node_arch="x64"; node_sha256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    export NODE_ARCH="${node_arch}" NODE_SHA256="${node_sha256}" NODE_VERSION; \
    python3 -c 'import hashlib, os, pathlib, shutil, tarfile, urllib.request; version=os.environ["NODE_VERSION"]; arch=os.environ["NODE_ARCH"]; filename="node-v{version}-linux-{arch}.tar.xz".format(version=version, arch=arch); cached=pathlib.Path("/tmp/node-dist") / filename; target=pathlib.Path("/tmp/node.tar.xz"); shutil.copyfile(cached, target) if cached.is_file() else urllib.request.urlretrieve("https://nodejs.org/dist/v{version}/{filename}".format(version=version, filename=filename), target); actual=hashlib.sha256(target.read_bytes()).hexdigest(); expected=os.environ["NODE_SHA256"]; assert actual == expected, "Node archive checksum mismatch: {}".format(actual); archive=tarfile.open(target, "r:xz"); archive.extractall("/tmp/node-extract", filter="data"); archive.close()'; \
    cp -a "/tmp/node-extract/node-v${NODE_VERSION}-linux-${node_arch}/." /usr/local/; \
    rm -rf /tmp/node.tar.xz /tmp/node-extract; \
    npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund; \
    apt-get update; \
    apt-get install --no-install-recommends --yes libimage-exiftool-perl; \
    rm -rf /var/lib/apt/lists/* /root/.npm; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    exiftool -ver
