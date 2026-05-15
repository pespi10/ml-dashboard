# ML Dashboard

Dashboard de rentabilidades y stock para Mercado Libre. Construido con Next.js 14, deployado en Vercel.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Charts**: Recharts
- **Auth**: OAuth 2.0 nativo de ML (sin NextAuth)
- **Deploy**: Vercel

## Setup

### 1. Crear app en Mercado Libre

1. Ir a https://developers.mercadolibre.com.ar/
2. Crear nueva app
3. En "URL de retorno" poner: `https://TU-PROYECTO.vercel.app/api/auth/callback`
4. Copiar Client ID y Client Secret

### 2. Variables de entorno

Copiar `.env.local` y completar:

```env
ML_CLIENT_ID=12345678
ML_CLIENT_SECRET=abc123...
NEXT_PUBLIC_APP_URL=https://tu-proyecto.vercel.app
ML_REDIRECT_URI=https://tu-proyecto.vercel.app/api/auth/callback
SESSION_SECRET=genera-con-openssl-rand-base64-32
```

### 3. Deploy en Vercel

```bash
npm install -g vercel
vercel
```

O conectar el repo en vercel.com y agregar las env vars en el dashboard.

### 4. Dev local

```bash
npm install
npm run dev
# → http://localhost:3000
```

Para dev local, el redirect URI de ML debe ser:
`http://localhost:3000/api/auth/callback`

## Páginas

| Ruta | Descripción |
|------|-------------|
| `/` | Redirect automático |
| `/login` | OAuth con ML |
| `/dashboard` | Overview: GMV, órdenes, gráfico, alertas |
| `/dashboard/productos` | Listado de publicaciones con filtros |
| `/dashboard/ventas` | Historial de órdenes (30 días) |
| `/dashboard/rentabilidad` | Calculadora de margen y ROI |

## API Routes

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/auth/login` | Inicia OAuth |
| `GET /api/auth/callback` | Callback de ML |
| `GET /api/auth/logout` | Cierra sesión |
| `GET /api/dashboard` | Stats consolidadas |
| `GET /api/products` | Publicaciones |
| `GET /api/sales` | Órdenes 30d |

## Responsive

- **Desktop**: Sidebar fija de 220px + contenido principal
- **Mobile**: Top bar con hamburger menu + drawer
