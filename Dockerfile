FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY . .

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "run", "start"]
