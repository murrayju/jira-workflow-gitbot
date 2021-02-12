FROM node:14-slim as builder
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN [ "npm", "run", "build" ]

FROM node:14-slim as prod
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force
ENV NODE_ENV="production"
COPY --from=builder ["/usr/src/app/lib", "/usr/src/app/lib"]
CMD [ "npm", "run", "serve" ]
