FROM node:20-slim

# Create a non-root user
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN chown -R appuser:appuser /app
USER appuser

CMD ["npm", "start"]