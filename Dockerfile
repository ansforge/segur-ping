# Image used by the Jenkins pipeline agent. Provides Node.js, git, a ping
# binary (iputils) and the Paris timezone so recorded hours are local.
FROM node:22-alpine

RUN apk add --no-cache iputils git tzdata

ENV TZ=Europe/Paris

WORKDIR /workspace

# No npm dependencies — the scripts use only the Node standard library.
