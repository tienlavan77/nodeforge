# Builds a disposable Linux runner with real ACL and mount tooling. Only this
# directory is the build context; project source is supplied read-only at runtime.
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends acl util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY provision.mjs /runner/provision.mjs
ENV NODEFORGE_FILESYSTEM_CONTAINER=1
ENTRYPOINT ["node", "/runner/provision.mjs"]
