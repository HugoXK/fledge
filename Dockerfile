FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# #395: src/lib/deployments.ts imports the shared pure drift/gate module under
# scripts/lib, so the build stage needs that tree as well as src.
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime
# #183: the build identity. The build stage has no `.git`, so the commit can
# only reach the image through these two build args; `/healthz` serves them so a
# deploy can be named from outside. An unstamped local build answers `unknown`
# rather than inventing a value.
ARG GIT_SHA=
ARG BUILD_TIME=
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY scripts ./scripts
COPY bridge ./bridge
# The console reads these two to state which release it runs; without them the
# admin release card would say "not available in this build".
COPY CHANGELOG.md ./
COPY changelog.d ./changelog.d
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
