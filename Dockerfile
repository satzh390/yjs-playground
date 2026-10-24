FROM node:22-alpine

WORKDIR /workspace
COPY . .
RUN npm ci

EXPOSE 1234 5173
CMD ["npm", "run", "demo"]
