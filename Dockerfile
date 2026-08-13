# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/public/draft-temporal-model.json ./model/draft-temporal-model.json
COPY --from=build /app/public/all-pro-team-model.json ./model/all-pro-team-model.json
COPY --from=build /app/public/draft-nextgen-model.json ./model/draft-nextgen-model.json
COPY --from=build /app/public/nextgen-series-calibration.json ./model/nextgen-series-calibration.json
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/server ./server
COPY --from=build /app/.vinext ./.vinext
EXPOSE 3000 3001
CMD ["npm", "start"]
