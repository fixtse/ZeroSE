ARG BUILD_FROM=ghcr.io/fixtse/zerose:latest
FROM ${BUILD_FROM}
# Supervisor supplies /data and SUPERVISOR_TOKEN. No host ports are published.
USER root
CMD ["node", "dist/scripts/start-home-assistant-addon.js"]
