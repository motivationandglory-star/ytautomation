# FFmpeg Service

Microservicio para concatenar audio y ensamblar video, usado por el workflow de n8n.

## Endpoints

- `GET /` — health check
- `POST /concat` — concatena clips de audio y devuelve base64
- `POST /compose` — combina imagen + audio en video mp4 y devuelve base64

## Deploy en Render.com

1. Subí esta carpeta a un repo de GitHub
2. En render.com → New → Web Service → conectá el repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Plan: Free
