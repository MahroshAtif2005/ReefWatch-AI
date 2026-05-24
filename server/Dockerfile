FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV SKIP_STARTUP_REFRESH=true
EXPOSE 4000
CMD ["npm", "start"]
