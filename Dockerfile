FROM node:20-alpine

RUN apk add --no-cache git g++ make python3

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "index.js"]
